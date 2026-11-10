#!/usr/bin/env python3
"""Read-only UniFi inventory collector for Home Hub: the included router adapter ("unifi").

Runs from a scheduled job on the machine that serves Home Hub (any unprivileged user that owns
router-private/). It reads the UniFi Network local integration API on the gateway with an API key kept in
router-private/unifi-api-key (0600) and writes data/router-observations.json, the observation file
server/router-data.mjs reads (client census plus the state of the network hardware). GET requests only.
The router's self-signed certificate is pinned by SHA-256 fingerprint (router-private/unifi-cert-sha256);
the key is never sent before the pin matches, and nothing here prints or stores the key.

Which gateway and which networks: local/site.json. The gateway is router.host, else the address of the
machine with role "router"; the networks are lanCidrs (clients outside them are dropped); router.site is
the UniFi site name. UNIFI_HOST, UNIFI_LAN and UNIFI_SITE override the file. HOME_HUB_SITE_CONFIG selects
another file ("none" = no file). HOME_HUB_ROOT is where data/ and router-private/ live (default: the
checkout, or its parent when the checkout is deployed as <root>/app next to data/).

Two backends, chosen by what exists under router-private/: unifi-api-key (Network 9.x integration API,
X-API-KEY) or unifi-credentials.json (a dedicated View Only local admin signing in through the same
local session API the UniFi web UI uses; the TOKEN cookie is cached in unifi-session.json and reused).

Usage: collect-router-unifi.py            # cron: write the snapshot, print nothing
       collect-router-unifi.py --pin      # record the router certificate fingerprint (first install)
       collect-router-unifi.py --check    # collect, write, print a one-line summary, exit 3 if the key is rejected
       collect-router-unifi.py --dry-run  # like --check without writing
       collect-router-unifi.py --dump     # print the field names and a few raw records (no secrets)
       collect-router-unifi.py --store-credentials  # read "username\npassword\n" from stdin into unifi-credentials.json (0600)
"""
import datetime, fcntl, hashlib, http.client, ipaddress, json, os, pathlib, re, socket, ssl, stat, sys

REPO = pathlib.Path(__file__).resolve().parents[1]
PRIVATE_NETWORKS = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
SITE_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def default_root(env=os.environ, repo=REPO):
    """Where data/ and router-private/ live."""
    if env.get('HOME_HUB_ROOT'):
        return pathlib.Path(env['HOME_HUB_ROOT'])
    # A checkout deployed as <root>/app keeps its data and secrets beside the code, not inside it.
    if repo.name == 'app' and (repo.parent / 'data').is_dir():
        return repo.parent
    return repo


def load_site(env=os.environ, repo=REPO):
    """The site configuration as a dict; {} when there is none or it cannot be read."""
    choice = env.get('HOME_HUB_SITE_CONFIG')
    if choice == 'none':
        return {}
    try:
        data = json.loads((pathlib.Path(choice) if choice else repo / 'local/site.json').read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def site_settings(site, env=os.environ):
    """(gateway host, [networks], UniFi site name) from the environment, then site.json, then defaults."""
    router = site.get('router') if isinstance(site.get('router'), dict) else {}
    machines = [m for m in site.get('machines') or [] if isinstance(m, dict)] if isinstance(site.get('machines'), list) else []
    gateway = next((m.get('ip') for m in machines if m.get('role') == 'router' and isinstance(m.get('ip'), str) and m.get('ip')), None)
    host = env.get('UNIFI_HOST') or (router.get('host') if isinstance(router.get('host'), str) else None) or gateway or '192.168.1.1'
    wanted = [env['UNIFI_LAN']] if env.get('UNIFI_LAN') else [c for c in site.get('lanCidrs') or [] if isinstance(c, str)][:16] if isinstance(site.get('lanCidrs'), list) else []
    networks = []
    for text in wanted:
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            pass
    if not networks:
        try:
            networks = [ipaddress.ip_network(host + '/24', strict=False)]  # the /24 around the gateway
        except ValueError:
            networks = [ipaddress.ip_network(n) for n in PRIVATE_NETWORKS]  # the gateway is a host name
    name = env.get('UNIFI_SITE') or router.get('site') or 'default'
    return str(host), networks, name if isinstance(name, str) and SITE_ID.match(name) else 'default'


ROOT = default_root()
PRIVATE = ROOT / 'router-private'
KEY_FILE = PRIVATE / 'unifi-api-key'
PIN_FILE = PRIVATE / 'unifi-cert-sha256'
CRED_FILE = PRIVATE / 'unifi-credentials.json'
SESSION_FILE = PRIVATE / 'unifi-session.json'
TARGET = ROOT / 'data/router-observations.json'
# The gateway, the networks it serves and its UniFi site name (see the module docstring).
HOST, LANS, SITE = site_settings(load_site())
PORT, BASE = 443, '/proxy/network/integration/v1'
LEGACY = '/proxy/network/api/s/' + SITE
USER_AGENT = 'home-hub-unifi-collector/1'
LAN = LANS[0]
MAC = re.compile(r'^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$')
TIMEOUT, LIMIT, PAGE, MAX_PAGES, MAX_DEVICES, MAX_HARDWARE, KNOWN_DAYS = 10, 1024 * 1024, 200, 3, 500, 50, 90
BANDS = {'2.4': 'Wi-Fi · 2.4 GHz', '5': 'Wi-Fi · 5 GHz', '6': 'Wi-Fi · 6 GHz'}
MODELS = {'UDR7': 'UniFi Dream Router 7'}


class CollectorError(Exception):
    """Carries a short error code only, never a response body or the key."""


def verify_pin(observed, expected):
    if expected is not None and observed != expected:
        raise CollectorError('certificate-changed')


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, fingerprint, timeout=TIMEOUT):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # self-signed router certificate; trust is the pinned fingerprint
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        super().__init__(host, port, timeout=timeout, context=context)
        self.fingerprint, self.observed = fingerprint, None

    def connect(self):
        super().connect()
        self.observed = hashlib.sha256(self.sock.getpeercert(binary_form=True)).hexdigest()
        try:
            verify_pin(self.observed, self.fingerprint)
        except CollectorError:
            self.close()
            raise


def observe_fingerprint():
    connection = PinnedConnection(HOST, PORT, None)
    try:
        try:
            connection.connect()
        except (socket.timeout, TimeoutError):
            raise CollectorError('timeout')
        except OSError:
            raise CollectorError('unreachable')
        return connection.observed
    finally:
        connection.close()


def read_limited(response, limit=LIMIT):
    chunks, size = [], 0
    while True:
        chunk = response.read(65536)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise CollectorError('response-too-large')
        chunks.append(chunk)
    return b''.join(chunks)


def request(method, path, fingerprint, headers=None, body=None):
    """One bounded HTTPS exchange over the pinned connection. Returns (status, headers, body bytes)."""
    connection = PinnedConnection(HOST, PORT, fingerprint)
    try:
        try:
            connection.request(method, path, body=body, headers=dict({'Accept': 'application/json', 'User-Agent': USER_AGENT}, **(headers or {})))
            response = connection.getresponse()
            data = read_limited(response)
        except CollectorError:
            raise
        except (socket.timeout, TimeoutError):
            raise CollectorError('timeout')
        except (OSError, http.client.HTTPException):
            raise CollectorError('unreachable')
    finally:
        connection.close()
    return response.status, response.getheaders(), data


def check_status(status):
    if status == 401:
        raise CollectorError('unauthorized')
    if status == 403:
        raise CollectorError('forbidden')
    if status == 429:
        raise CollectorError('rate-limited')
    if status != 200:
        raise CollectorError('http-%d' % status)


def decode(body):
    try:
        return json.loads(body)
    except ValueError:
        raise CollectorError('invalid-response')


def fetch(path, key, fingerprint):
    status, _, body = request('GET', path, fingerprint, {'X-API-KEY': key})
    check_status(status)
    return decode(body)


def load_pin():
    try:
        value = PIN_FILE.read_text().strip().lower()
    except OSError:
        raise CollectorError('certificate-not-pinned')
    if not re.fullmatch(r'[0-9a-f]{64}', value):
        raise CollectorError('certificate-not-pinned')
    return value


def load_key():
    try:
        status = KEY_FILE.stat()
        key = KEY_FILE.read_text().strip()
    except OSError:
        raise CollectorError('key-missing')
    if stat.S_IMODE(status.st_mode) & 0o077 or status.st_uid != os.getuid():
        raise CollectorError('key-permissions')
    if not key or len(key) > 512 or not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', key):
        raise CollectorError('key-invalid')
    return key


def load_credentials():
    try:
        status = CRED_FILE.stat()
        data = json.loads(CRED_FILE.read_text())
    except OSError:
        raise CollectorError('credentials-missing')
    except ValueError:
        raise CollectorError('credentials-invalid')
    if stat.S_IMODE(status.st_mode) & 0o077 or status.st_uid != os.getuid():
        raise CollectorError('credentials-permissions')
    username, password = data.get('username') if isinstance(data, dict) else None, data.get('password') if isinstance(data, dict) else None
    if not isinstance(username, str) or not isinstance(password, str) or not re.fullmatch(r'[A-Za-z0-9._@-]{1,64}', username) or not 1 <= len(password) <= 256 or any(ord(ch) < 32 for ch in password):
        raise CollectorError('credentials-invalid')
    return username, password


def store_credentials(stream):
    username = stream.readline().rstrip('\r\n')
    password = stream.readline().rstrip('\r\n')
    if not re.fullmatch(r'[A-Za-z0-9._@-]{1,64}', username) or not 1 <= len(password) <= 256 or any(ord(ch) < 32 for ch in password):
        raise CollectorError('credentials-invalid')
    os.umask(0o077)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    tmp = CRED_FILE.with_suffix('.incoming')
    tmp.write_text(json.dumps({'username': username, 'password': password}))
    os.chmod(tmp, 0o600)
    tmp.replace(CRED_FILE)
    try:
        SESSION_FILE.unlink()
    except OSError:
        pass


def extract_token(headers):
    for name, value in headers:
        if name.lower() == 'set-cookie' and value.startswith('TOKEN='):
            token = value.split(';', 1)[0][6:]
            if re.fullmatch(r'[A-Za-z0-9._-]{20,4096}', token):
                return token
    raise CollectorError('login-no-token')


def session_login(username, password, pin):
    body = json.dumps({'username': username, 'password': password, 'rememberMe': False})
    status, headers, _ = request('POST', '/api/auth/login', pin, {'Content-Type': 'application/json'}, body)
    if status in (400, 401, 403, 499):
        raise CollectorError('unauthorized')
    if status == 429:
        raise CollectorError('rate-limited')
    if status != 200:
        raise CollectorError('login-http-%d' % status)
    return extract_token(headers)


def load_session(username):
    try:
        data = json.loads(SESSION_FILE.read_text())
    except (OSError, ValueError):
        return None
    token = data.get('token') if isinstance(data, dict) else None
    if data.get('username') != username or not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._-]{20,4096}', token):
        return None
    return token


def save_session(username, token):
    tmp = SESSION_FILE.with_suffix('.incoming')
    tmp.write_text(json.dumps({'username': username, 'token': token, 'savedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    os.chmod(tmp, 0o600)
    tmp.replace(SESSION_FILE)


def session_get(path, token, pin):
    status, _, body = request('GET', path, pin, {'Cookie': 'TOKEN=' + token})
    if status == 401:
        raise CollectorError('session-expired')
    check_status(status)
    payload = decode(body)
    if isinstance(payload, dict) and isinstance(payload.get('data'), list):
        return payload['data']
    raise CollectorError('invalid-response')


def epoch_iso(value):
    try:
        return datetime.datetime.fromtimestamp(int(value), datetime.timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return ''


def adapt_session(sta, devices, users):
    """Reshape the session API tables into the integration-API-like records parse() understands."""
    clients = [{'macAddress': c.get('mac'), 'ipAddress': c.get('ip'), 'name': c.get('name') or c.get('hostname'),
                'type': 'WIRED' if c.get('is_wired') else 'WIRELESS', 'radio': c.get('radio'),
                'connectedAt': epoch_iso(c.get('latest_assoc_time') or c.get('assoc_time')),
                'uplinkDeviceId': c.get('ap_mac') or c.get('sw_mac') or c.get('gw_mac')} for c in sta if isinstance(c, dict)]
    hardware = [{'id': d.get('mac'), 'name': d.get('name'), 'model': d.get('shortname') or d.get('model'), 'macAddress': d.get('mac'),
                 'ipAddress': d.get('lan_ip') or d.get('ip'), 'state': 'ONLINE' if d.get('state') == 1 else 'OFFLINE',
                 'firmwareVersion': d.get('version')} for d in devices if isinstance(d, dict)]
    known = {}
    for user in users:
        if not isinstance(user, dict):
            continue
        mac = str(user.get('mac') or '').lower()
        seen = epoch_iso(user.get('last_seen'))
        if MAC.fullmatch(mac) and seen:
            known[mac] = {'ip': user.get('fixed_ip') if user.get('use_fixedip') else user.get('last_ip') or '', 'name': user.get('name') or user.get('hostname') or '',
                          'type': 'WIRED' if user.get('is_wired') else 'WIRELESS', 'lastSeen': seen}
    return clients, hardware, known


def rows(payload):
    if isinstance(payload, list):
        return payload, len(payload)
    if isinstance(payload, dict) and isinstance(payload.get('data'), list):
        total = payload.get('totalCount')
        return payload['data'], total if isinstance(total, int) else len(payload['data'])
    raise CollectorError('invalid-response')


def fetch_all(path, key, pin):
    items, offset = [], 0
    for _ in range(MAX_PAGES):
        page, total = rows(fetch('%s?offset=%d&limit=%d' % (path, offset, PAGE), key, pin))
        items.extend(x for x in page if isinstance(x, dict))
        offset += len(page)
        if not page or len(page) < PAGE or offset >= total:
            break
    return items[:MAX_DEVICES]


def pick(obj, *names, **options):
    max_len = options.get('max_len', 160)
    for name in names:
        value = obj.get(name)
        if isinstance(value, bool):
            continue
        if isinstance(value, (str, int, float)) and str(value).strip():
            return str(value).strip()[:max_len]
    return ''


def band(client):
    for obj in [client] + [v for v in client.values() if isinstance(v, dict)]:
        for key in ('frequencyGHz', 'frequency', 'band', 'radioBand', 'radio', 'wifiBand', 'channelBand'):
            value = obj.get(key)
            if value is None or value == '' or isinstance(value, bool):
                continue
            text = str(value).strip().lower()
            if text in ('ng', '2g', '2') or text.startswith('2.4') or text.startswith('24'):
                return '2.4'
            if text in ('6e', '6g') or text.startswith('6'):
                return '6'
            if text in ('na', 'ac', '5g') or text.startswith('5'):
                return '5'
    return ''


def lan_ip(value):
    try:
        ip = ipaddress.ip_address(str(value).strip())
    except ValueError:
        return None
    network = next((n for n in LANS if ip in n), None)
    # A host address only: not the network or broadcast address (a /31 or /32 has neither).
    if network is None or (network.prefixlen < 31 and ip in (network.network_address, network.broadcast_address)):
        return None
    return str(ip)


def lan_mac(ip, arp_path='/proc/net/arp'):
    """The MAC the router actually uses on the LAN (its base MAC in the API can differ), from the kernel neighbor table."""
    try:
        lines = pathlib.Path(arp_path).read_text().splitlines()[1:]
    except OSError:
        return ''
    for line in lines[:4096]:
        parts = line.split()
        if len(parts) >= 4 and parts[0] == ip and parts[2] == '0x2' and MAC.fullmatch(parts[3].lower()):
            return parts[3].lower()
    return ''


def parse_time(value):
    try:
        text = str(value).strip()
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        parsed = datetime.datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)
    except (ValueError, TypeError):
        return None


def parse(clients, devices, now, previous_known):
    names, hardware = {}, []
    for device in devices[:MAX_HARDWARE]:
        mac = pick(device, 'macAddress', 'mac').lower()
        entry = {'name': pick(device, 'name'), 'model': pick(device, 'model', max_len=40), 'mac': mac if MAC.fullmatch(mac) else '',
                 'ip': lan_ip(pick(device, 'ipAddress', 'ip')), 'state': pick(device, 'state', max_len=32),
                 'firmware': pick(device, 'firmwareVersion', 'firmware', max_len=64)}
        hardware.append(entry)
        names[pick(device, 'id', max_len=64)] = entry['name']
    gateway = (next((h for h in hardware if h['ip'] == HOST), None)
               or next((h for h in hardware if h['model'].upper().startswith(('UDR', 'UDM', 'UCG', 'UXG'))), None)
               or (hardware[0] if hardware else None))
    records, counts = {}, {'wired': 0, 'wireless': 0, 'other': 0}
    for client in clients:
        mac = pick(client, 'macAddress', 'mac').lower()
        ip = lan_ip(pick(client, 'ipAddress', 'ip'))
        if not MAC.fullmatch(mac) or not ip:
            continue
        kind = pick(client, 'type', 'connectionType', max_len=16).upper()
        if kind == 'WIRED':
            connection, presence = 'Ethernet', 'reachable'
            counts['wired'] += 1
        elif kind == 'WIRELESS':
            connection, presence = BANDS.get(band(client), 'Wi-Fi'), 'associated'
            counts['wireless'] += 1
        else:
            connection, presence = 'Unknown', 'reachable'
            counts['other'] += 1
        records[mac] = {'mac': mac, 'ip': ip, 'name': pick(client, 'name', 'hostname', 'displayName'), 'connection': connection,
                        'presence': presence, 'connected': True, 'type': kind or 'UNKNOWN',
                        'connectedAt': pick(client, 'connectedAt', max_len=40), 'lastSeen': now,
                        'uplink': names.get(pick(client, 'uplinkDeviceId', max_len=64), '')}
    now_time = parse_time(now) or datetime.datetime.now(datetime.timezone.utc)
    cutoff = now_time - datetime.timedelta(days=KNOWN_DAYS)
    known = {}
    for mac, entry in (previous_known or {}).items():
        seen = parse_time(entry.get('lastSeen')) if isinstance(entry, dict) else None
        if isinstance(mac, str) and MAC.fullmatch(mac) and seen and seen >= cutoff:
            known[mac] = {'ip': lan_ip(entry.get('ip')), 'name': pick(entry, 'name'), 'type': pick(entry, 'type', max_len=16), 'lastSeen': str(entry.get('lastSeen'))[:40]}
    for mac, record in records.items():
        known[mac] = {'ip': record['ip'], 'name': record['name'], 'type': record['type'], 'lastSeen': now}
    known = dict(sorted(known.items(), key=lambda item: item[1]['lastSeen'], reverse=True)[:MAX_DEVICES])
    model = gateway['model'] if gateway else ''
    return {'devices': list(records.values())[:MAX_DEVICES], 'clientCounts': counts,
            'model': '%s (%s)' % (MODELS[model], model) if model in MODELS else model,
            'firmware': gateway['firmware'] if gateway else '', 'routerMac': gateway['mac'] if gateway else '',
            'routerIp': HOST, 'unifiDevices': hardware, 'knownClients': known}


def previous_known(previous):
    return previous.get('knownClients') if isinstance(previous.get('knownClients'), dict) else {}


def observe_key(now, previous, pin):
    key = load_key()
    sites = rows(fetch(BASE + '/sites', key, pin))[0]
    site = next((s for s in sites if isinstance(s, dict) and SITE_ID.match(pick(s, 'id', max_len=64))), None)
    if site is None:
        raise CollectorError('no-site')
    site_id = pick(site, 'id', max_len=64)
    clients = fetch_all('%s/sites/%s/clients' % (BASE, site_id), key, pin)
    devices = fetch_all('%s/sites/%s/devices' % (BASE, site_id), key, pin)
    try:
        version = pick(fetch(BASE + '/info', key, pin), 'applicationVersion', max_len=40)
    except CollectorError:
        version = ''
    result = parse(clients, devices, now, previous_known(previous))
    result.update(site=pick(site, 'name', 'internalReference') or site_id, applicationVersion=version, backend='integration-api')
    return result


def observe_session(now, previous, pin):
    username, password = load_credentials()
    token = load_session(username)

    def pull(token):
        sta = session_get(LEGACY + '/stat/sta', token, pin)[:MAX_DEVICES * 2]
        devices = session_get(LEGACY + '/stat/device', token, pin)[:MAX_HARDWARE]
        try:
            users = session_get(LEGACY + '/rest/user', token, pin)[:MAX_DEVICES * 4]
        except CollectorError as error:
            if str(error) in ('session-expired', 'forbidden', 'rate-limited'):
                raise
            users = []
        try:
            info = session_get(LEGACY + '/stat/sysinfo', token, pin)
            version = pick(info[0], 'version', max_len=40) if info and isinstance(info[0], dict) else ''
        except CollectorError:
            version = ''
        return sta, devices, users, version

    try:
        if token is None:
            raise CollectorError('session-expired')
        sta, devices, users, version = pull(token)
    except CollectorError as error:
        if str(error) != 'session-expired':
            raise
        token = session_login(username, password, pin)
        save_session(username, token)
        sta, devices, users, version = pull(token)
    clients, hardware, known = adapt_session(sta, devices, users)
    merged = dict(previous_known(previous))
    for mac, entry in known.items():
        if mac not in merged or str(merged[mac].get('lastSeen', '')) <= entry['lastSeen']:
            merged[mac] = entry
    result = parse(clients, hardware, now, merged)
    result.update(site=SITE, applicationVersion=version, backend='session-api')
    return result


def observe(now, previous):
    pin = load_pin()
    result = observe_key(now, previous, pin) if KEY_FILE.exists() else observe_session(now, previous, pin)
    result['routerBaseMac'] = result['routerMac']
    result['routerMac'] = lan_mac(HOST) or result['routerMac']
    return result


def collect(write=True):
    os.umask(0o077)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    with (PRIVATE / 'collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return None
        try:
            previous = json.loads(TARGET.read_text())
        except (OSError, ValueError):
            previous = {}
        if not isinstance(previous, dict):
            previous = {}
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        snapshot = dict(previous)
        snapshot.update(schemaVersion=1, attemptedAt=now)
        try:
            snapshot.update(observe(now, previous))
            snapshot.update(source='UniFi Network API', status='ok', observedAt=now, error=None)
        except CollectorError as error:
            snapshot.update(status='unavailable', error=str(error), observedAt=previous.get('observedAt'), devices=previous.get('devices', []))
        except (TypeError, KeyError, AttributeError, ValueError):
            snapshot.update(status='unavailable', error='internal-error', observedAt=previous.get('observedAt'), devices=previous.get('devices', []))
        if write:
            tmp = TARGET.with_suffix('.incoming')
            tmp.write_text(json.dumps(snapshot, separators=(',', ':')))
            os.chmod(tmp, 0o600)
            tmp.replace(TARGET)
        return snapshot


def scrub(item):
    """Drop vendor-private and secret-looking keys before anything is printed."""
    if not isinstance(item, dict):
        return item
    return {k: v for k, v in item.items() if not k.startswith('x_') and not any(word in k.lower() for word in ('key', 'secret', 'password', 'token', 'psk', 'passphrase'))}


def dump():
    pin = load_pin()
    out = {}
    if KEY_FILE.exists():
        key = load_key()
        sites = rows(fetch(BASE + '/sites', key, pin))[0]
        site_id = pick(sites[0], 'id', max_len=64) if sites and isinstance(sites[0], dict) else ''
        if not SITE_ID.match(site_id):
            raise CollectorError('no-site')
        out.update(backend='integration-api', info=fetch(BASE + '/info', key, pin), sites=sites)
        for name in ('clients', 'devices'):
            payload = fetch('%s/sites/%s/%s?offset=0&limit=%d' % (BASE, site_id, name, PAGE), key, pin)
            items = rows(payload)[0]
            out[name] = {'envelope': {k: v for k, v in payload.items() if k != 'data'} if isinstance(payload, dict) else 'list',
                         'count': len(items), 'fields': sorted({k for item in items if isinstance(item, dict) for k in item}), 'samples': [scrub(i) for i in items[:4]]}
    else:
        username, password = load_credentials()
        token = load_session(username)
        if token is None:
            token = session_login(username, password, pin)
            save_session(username, token)
        out['backend'] = 'session-api'
        for name in ('stat/sysinfo', 'stat/sta', 'stat/device', 'rest/user'):
            items = session_get('%s/%s' % (LEGACY, name), token, pin)
            out[name] = {'count': len(items), 'fields': sorted({k for item in items if isinstance(item, dict) for k in item}), 'samples': [scrub(i) for i in items[:3]]}
    print(json.dumps(out, indent=1, default=str)[:60000])


def main(argv):
    flags = set(argv)
    try:
        if '--pin' in flags:
            fingerprint = observe_fingerprint()
            PRIVATE.mkdir(parents=True, exist_ok=True)
            PIN_FILE.write_text(fingerprint + '\n')
            os.chmod(PIN_FILE, 0o600)
            print(json.dumps({'pinned': fingerprint, 'host': HOST}))
        if '--store-credentials' in flags:
            store_credentials(sys.stdin)
            print(json.dumps({'stored': str(CRED_FILE), 'mode': '0600'}))
            return 0
        if '--dump' in flags:
            dump()
            return 0
    except CollectorError as error:
        print(json.dumps({'status': 'unavailable', 'error': str(error)}))
        return 1
    if '--check' in flags or '--dry-run' in flags:
        snapshot = collect(write='--dry-run' not in flags)
        if snapshot is None:
            print(json.dumps({'status': 'busy'}))
            return 4
        summary = {k: snapshot.get(k) for k in ('status', 'error', 'source', 'backend', 'observedAt', 'applicationVersion', 'site', 'model', 'firmware', 'routerMac', 'clientCounts')}
        summary.update(clients=len(snapshot.get('devices') or []), pinned=PIN_FILE.exists(), written='--dry-run' not in flags)
        print(json.dumps(summary))
        if snapshot.get('status') != 'ok':
            return 3 if snapshot.get('error') == 'unauthorized' else 1
        return 0
    if flags - {'--pin'}:
        print(__doc__)
        return 2
    if '--pin' not in flags:
        collect()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
