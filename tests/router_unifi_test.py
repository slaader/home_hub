import importlib.util, io, json, os, pathlib, stat, sys, tempfile, unittest
os.environ['UNIFI_HOST'] = '10.0.0.1'
os.environ.pop('UNIFI_LAN', None)
os.environ['HOME_HUB_SITE_CONFIG'] = 'none'  # the module settings come from the environment above, never from a real site
os.environ.pop('UNIFI_SITE', None)
for name in ('HOME_HUB_ROOT', 'HOME_HUB_HOME', 'HOME_HUB_CONFIG_DIR', 'DATA_DIR'):
    os.environ.pop(name, None)  # where data/ and router-private/ are comes from each test, never from the shell
spec = importlib.util.spec_from_file_location('unifi', pathlib.Path(__file__).resolve().parents[1] / 'scripts/collect-router-unifi.py')
unifi = importlib.util.module_from_spec(spec); spec.loader.exec_module(unifi)
NOW = '2026-10-31T21:00:00+00:00'
DEVICES = [{'id': 'dev-1', 'name': 'Gateway', 'model': 'UDR7', 'macAddress': 'A8:9C:6C:0E:8D:15', 'ipAddress': '10.0.0.1', 'state': 'ONLINE', 'firmwareVersion': '4.3.6'}]
CLIENTS = [
 {'id': 'c1', 'name': 'Mac Studio', 'macAddress': '7C:D6:2C:0A:06:A5', 'ipAddress': '10.0.0.151', 'type': 'WIRED', 'connectedAt': '2026-10-31T19:00:00Z', 'uplinkDeviceId': 'dev-1'},
 {'id': 'c2', 'name': 'iPhone', 'macAddress': 'aa:79:65:5d:a9:b6', 'ipAddress': '10.0.0.77', 'type': 'WIRELESS', 'frequencyGHz': 5},
 {'id': 'c3', 'name': 'Purifier', 'macAddress': '1c:90:ff:32:b6:07', 'ipAddress': '10.0.0.86', 'type': 'WIRELESS', 'wireless': {'radio': 'ng'}},
 {'id': 'c4', 'name': 'Laptop', 'macAddress': 'c0:c7:db:13:32:56', 'ipAddress': '10.0.0.218', 'type': 'WIRELESS'},
 {'id': 'c5', 'name': 'Phone 6E', 'macAddress': 'b0:4a:39:5f:9f:bd', 'ipAddress': '10.0.0.217', 'type': 'WIRELESS', 'band': '6 GHz'},
 {'id': 'c6', 'name': 'Road warrior', 'macAddress': '00:11:22:33:44:55', 'ipAddress': '10.8.0.2', 'type': 'VPN'},
 {'id': 'c7', 'name': 'Broken', 'macAddress': 'not-a-mac', 'ipAddress': '10.0.0.9', 'type': 'WIRED'},
 {'id': 'c8', 'name': '<script>' * 100, 'macAddress': '50:de:06:b0:e8:f4', 'ipAddress': '10.0.0.220', 'type': 'WIRED'},
]
class Response:
 def __init__(self, data): self.data = io.BytesIO(data)
 def read(self, n): return self.data.read(n)
class UnifiTests(unittest.TestCase):
 def test_mapping(self):
  result = unifi.parse(CLIENTS, DEVICES, NOW, {})
  by_mac = {d['mac']: d for d in result['devices']}
  self.assertEqual(set(by_mac), {'7c:d6:2c:0a:06:a5', 'aa:79:65:5d:a9:b6', '1c:90:ff:32:b6:07', 'c0:c7:db:13:32:56', 'b0:4a:39:5f:9f:bd', '50:de:06:b0:e8:f4'})
  studio = by_mac['7c:d6:2c:0a:06:a5']
  self.assertEqual((studio['connection'], studio['presence'], studio['connected'], studio['uplink'], studio['ip']), ('Ethernet', 'reachable', True, 'Gateway', '10.0.0.151'))
  self.assertEqual((by_mac['aa:79:65:5d:a9:b6']['connection'], by_mac['aa:79:65:5d:a9:b6']['presence']), ('Wi-Fi · 5 GHz', 'associated'))
  self.assertEqual(by_mac['1c:90:ff:32:b6:07']['connection'], 'Wi-Fi · 2.4 GHz')
  self.assertEqual(by_mac['c0:c7:db:13:32:56']['connection'], 'Wi-Fi')
  self.assertEqual(by_mac['b0:4a:39:5f:9f:bd']['connection'], 'Wi-Fi · 6 GHz')
  self.assertEqual(len(by_mac['50:de:06:b0:e8:f4']['name']), 160)
  self.assertEqual((result['model'], result['firmware'], result['routerMac'], result['routerIp']), ('UniFi Dream Router 7 (UDR7)', '4.3.6', 'a8:9c:6c:0e:8d:15', '10.0.0.1'))
  self.assertEqual(result['clientCounts'], {'wired': 2, 'wireless': 4, 'other': 0})
  self.assertTrue(all(d['lastSeen'] == NOW for d in result['devices']))
  self.assertEqual(json.loads(json.dumps(result))['unifiDevices'][0]['state'], 'ONLINE')
 def test_known_clients_merge_and_prune(self):
  previous = {'de:ad:be:ef:00:01': {'ip': '10.0.0.40', 'name': 'Old TV', 'type': 'WIRELESS', 'lastSeen': '2026-10-30T10:00:00+00:00'},
              'de:ad:be:ef:00:02': {'ip': '10.0.0.41', 'name': 'Ancient', 'type': 'WIRED', 'lastSeen': '2026-01-01T00:00:00Z'},
              'garbage': {'lastSeen': NOW}}
  result = unifi.parse(CLIENTS[:1], DEVICES, NOW, previous)
  self.assertEqual(set(result['knownClients']), {'de:ad:be:ef:00:01', '7c:d6:2c:0a:06:a5'})
  self.assertEqual(result['knownClients']['de:ad:be:ef:00:01']['lastSeen'], '2026-10-30T10:00:00+00:00')
  self.assertEqual([d['mac'] for d in result['devices']], ['7c:d6:2c:0a:06:a5'])
 def test_bounds_and_envelopes(self):
  self.assertEqual(unifi.rows({'offset': 0, 'limit': 200, 'count': 1, 'totalCount': 1, 'data': [{'a': 1}]}), ([{'a': 1}], 1))
  self.assertEqual(unifi.rows([{'a': 1}]), ([{'a': 1}], 1))
  with self.assertRaises(unifi.CollectorError): unifi.rows({'error': 'x'})
  with self.assertRaises(unifi.CollectorError): unifi.read_limited(Response(b'x' * 2048), limit=1024)
  self.assertEqual(unifi.read_limited(Response(b'ok'), limit=1024), b'ok')
  self.assertIsNone(unifi.lan_ip('192.168.1.5')); self.assertIsNone(unifi.lan_ip('10.0.0.255')); self.assertEqual(unifi.lan_ip(' 10.0.0.74 '), '10.0.0.74')
  with self.assertRaises(unifi.CollectorError) as ctx: unifi.verify_pin('a' * 64, 'b' * 64)
  self.assertEqual(str(ctx.exception), 'certificate-changed')
  unifi.verify_pin('a' * 64, None); unifi.verify_pin('a' * 64, 'a' * 64)
 def test_lan_mac_from_neighbor_table(self):
  with tempfile.TemporaryDirectory() as tmp:
   arp = pathlib.Path(tmp) / 'arp'
   arp.write_text('IP address       HW type     Flags       HW address            Mask     Device\n10.0.0.1     0x1         0x0         00:00:00:00:00:00     *        enp12s0\n10.0.0.1     0x1         0x2         A8:9C:6C:0E:8D:1A     *        enp12s0\n10.0.0.25    0x1         0x2         d0:11:e5:2b:4f:e0     *        enp12s0\n')
   self.assertEqual(unifi.lan_mac('10.0.0.1', str(arp)), 'a8:9c:6c:0e:8d:1a')
   self.assertEqual(unifi.lan_mac('10.0.0.2', str(arp)), '')
   self.assertEqual(unifi.lan_mac('10.0.0.1', str(arp) + '.missing'), '')
 def test_session_adapter(self):
  sta = [{'mac': '7C:D6:2C:0A:06:A5', 'ip': '10.0.0.151', 'hostname': 'Slavomirs-Mac-Studio', 'is_wired': True, 'sw_mac': 'a8:9c:6c:0e:8d:15', 'last_seen': 1793481600, 'latest_assoc_time': 1793470000},
         {'mac': 'aa:79:65:5d:a9:b6', 'ip': '10.0.0.77', 'hostname': 'iPhone', 'name': 'Slavo phone', 'is_wired': False, 'radio': 'na', 'ap_mac': 'a8:9c:6c:0e:8d:15', 'last_seen': 1793481600},
         {'mac': '1c:90:ff:32:b6:07', 'ip': '10.0.0.86', 'is_wired': False, 'radio': 'ng', 'last_seen': 1793481600},
         {'mac': 'b0:4a:39:5f:9f:bd', 'ip': '10.0.0.217', 'is_wired': False, 'radio': '6e', 'last_seen': 1793481600},
         'garbage']
  devices = [{'mac': 'a8:9c:6c:0e:8d:15', 'ip': '10.227.137.41', 'lan_ip': '10.0.0.1', 'model': 'UDMA67A', 'shortname': 'UDR7', 'name': 'Gateway', 'version': '4.1.9.20120', 'state': 1}]
  users = [{'mac': 'de:ad:be:ef:00:01', 'hostname': 'Old TV', 'last_seen': 1793400000, 'is_wired': False, 'use_fixedip': True, 'fixed_ip': '10.0.0.40'},
           {'mac': '7c:d6:2c:0a:06:a5', 'name': 'Mac Studio', 'last_seen': 1793481500, 'is_wired': True},
           {'mac': 'bad', 'last_seen': 1793481500}, {'mac': 'de:ad:be:ef:00:02'}]
  clients, hardware, known = unifi.adapt_session(sta, devices, users)
  result = unifi.parse(clients, hardware, NOW, known)
  by_mac = {d['mac']: d for d in result['devices']}
  self.assertEqual(set(by_mac), {'7c:d6:2c:0a:06:a5', 'aa:79:65:5d:a9:b6', '1c:90:ff:32:b6:07', 'b0:4a:39:5f:9f:bd'})
  self.assertEqual((by_mac['7c:d6:2c:0a:06:a5']['connection'], by_mac['7c:d6:2c:0a:06:a5']['presence'], by_mac['7c:d6:2c:0a:06:a5']['name'], by_mac['7c:d6:2c:0a:06:a5']['uplink']), ('Ethernet', 'reachable', 'Slavomirs-Mac-Studio', 'Gateway'))
  self.assertEqual(by_mac['7c:d6:2c:0a:06:a5']['connectedAt'], '2026-10-31T18:06:40+00:00')
  self.assertEqual((by_mac['aa:79:65:5d:a9:b6']['connection'], by_mac['aa:79:65:5d:a9:b6']['name']), ('Wi-Fi · 5 GHz', 'Slavo phone'))
  self.assertEqual(by_mac['1c:90:ff:32:b6:07']['connection'], 'Wi-Fi · 2.4 GHz')
  self.assertEqual(by_mac['b0:4a:39:5f:9f:bd']['connection'], 'Wi-Fi · 6 GHz')
  self.assertEqual((result['model'], result['firmware'], result['routerMac'], result['unifiDevices'][0]['ip']), ('UniFi Dream Router 7 (UDR7)', '4.1.9.20120', 'a8:9c:6c:0e:8d:15', '10.0.0.1'))
  self.assertEqual(result['unifiDevices'][0]['state'], 'ONLINE')
  self.assertEqual(set(result['knownClients']), {'de:ad:be:ef:00:01', '7c:d6:2c:0a:06:a5', 'aa:79:65:5d:a9:b6', '1c:90:ff:32:b6:07', 'b0:4a:39:5f:9f:bd'})
  self.assertEqual(result['knownClients']['de:ad:be:ef:00:01'], {'ip': '10.0.0.40', 'name': 'Old TV', 'type': 'WIRELESS', 'lastSeen': '2026-10-30T22:40:00+00:00'})
  self.assertEqual(result['knownClients']['7c:d6:2c:0a:06:a5']['lastSeen'], NOW)
  self.assertEqual(unifi.epoch_iso('x'), ''); self.assertEqual(unifi.epoch_iso(None), '')
 def test_session_token_and_credentials(self):
  self.assertEqual(unifi.extract_token([('Content-Type', 'application/json'), ('Set-Cookie', 'TOKEN=eyJhbGciOiJIUzI1NiJ9.abc-def_ghi.012345; Path=/; HttpOnly'), ('Set-Cookie', 'other=1')]), 'eyJhbGciOiJIUzI1NiJ9.abc-def_ghi.012345')
  with self.assertRaises(unifi.CollectorError): unifi.extract_token([('Set-Cookie', 'TOKEN=short; Path=/')])
  with self.assertRaises(unifi.CollectorError): unifi.extract_token([])
  with tempfile.TemporaryDirectory() as tmp:
   saved = (unifi.PRIVATE, unifi.CRED_FILE, unifi.SESSION_FILE)
   unifi.PRIVATE, unifi.CRED_FILE, unifi.SESSION_FILE = pathlib.Path(tmp), pathlib.Path(tmp) / 'unifi-credentials.json', pathlib.Path(tmp) / 'unifi-session.json'
   try:
    with self.assertRaises(unifi.CollectorError) as ctx: unifi.load_credentials()
    self.assertEqual(str(ctx.exception), 'credentials-missing')
    unifi.SESSION_FILE.write_text('{"username":"home-hub-collector","token":"x"}')
    unifi.store_credentials(io.StringIO('home-hub-collector\ns3cret pass with spaces\n'))
    self.assertEqual(stat.S_IMODE(unifi.CRED_FILE.stat().st_mode), 0o600); self.assertFalse(unifi.SESSION_FILE.exists())
    self.assertEqual(unifi.load_credentials(), ('home-hub-collector', 's3cret pass with spaces'))
    os.chmod(unifi.CRED_FILE, 0o644)
    with self.assertRaises(unifi.CollectorError) as ctx: unifi.load_credentials()
    self.assertEqual(str(ctx.exception), 'credentials-permissions')
    with self.assertRaises(unifi.CollectorError): unifi.store_credentials(io.StringIO('bad user name\npw\n'))
    with self.assertRaises(unifi.CollectorError): unifi.store_credentials(io.StringIO('user\n\n'))
    unifi.save_session('home-hub-collector', 'eyJhbGciOiJIUzI1NiJ9.abc-def_ghi.012345')
    self.assertEqual(unifi.load_session('home-hub-collector'), 'eyJhbGciOiJIUzI1NiJ9.abc-def_ghi.012345'); self.assertIsNone(unifi.load_session('someone-else'))
    self.assertEqual(stat.S_IMODE(unifi.SESSION_FILE.stat().st_mode), 0o600)
   finally: unifi.PRIVATE, unifi.CRED_FILE, unifi.SESSION_FILE = saved
 def test_key_file_permissions(self):
  with tempfile.TemporaryDirectory() as tmp:
   key = pathlib.Path(tmp) / 'unifi-api-key'; original = unifi.KEY_FILE; unifi.KEY_FILE = key
   try:
    with self.assertRaises(unifi.CollectorError) as ctx: unifi.load_key()
    self.assertEqual(str(ctx.exception), 'key-missing')
    key.write_text('abc123\n'); os.chmod(key, 0o644)
    with self.assertRaises(unifi.CollectorError) as ctx: unifi.load_key()
    self.assertEqual(str(ctx.exception), 'key-permissions')
    os.chmod(key, 0o600); self.assertEqual(unifi.load_key(), 'abc123')
    key.write_text('bad key with spaces')
    with self.assertRaises(unifi.CollectorError) as ctx: unifi.load_key()
    self.assertEqual(str(ctx.exception), 'key-invalid')
   finally: unifi.KEY_FILE = original
 def test_site_configuration(self):
  site = {'lanCidrs': ['10.0.0.0/24', '10.0.20.0/24', 'nonsense'], 'router': {'adapter': 'unifi', 'host': '10.0.0.254', 'site': 'home'},
          'machines': [{'id': 'mini', 'ip': '10.0.0.25'}, {'id': 'gw', 'role': 'router', 'ip': '10.0.0.1'}]}
  host, lans, name = unifi.site_settings(site, {})
  self.assertEqual((host, [str(n) for n in lans], name), ('10.0.0.254', ['10.0.0.0/24', '10.0.20.0/24'], 'home'))
  self.assertEqual(unifi.site_settings({'machines': site['machines']}, {})[:1], ('10.0.0.1',), 'the machine with role router is the gateway')
  self.assertEqual([str(n) for n in unifi.site_settings({'machines': site['machines']}, {})[1]], ['10.0.0.0/24'], 'no lanCidrs: the /24 around the gateway')
  host, lans, name = unifi.site_settings(site, {'UNIFI_HOST': '10.9.0.1', 'UNIFI_LAN': '10.9.0.0/16', 'UNIFI_SITE': 'lab'})
  self.assertEqual((host, [str(n) for n in lans], name), ('10.9.0.1', ['10.9.0.0/16'], 'lab'), 'the environment overrides the file')
  self.assertEqual(unifi.site_settings({}, {})[0], '192.168.1.1')
  self.assertEqual(unifi.site_settings({'router': {'site': '../../etc'}}, {})[2], 'default', 'a site name that is not an id is refused')
  self.assertEqual(len(unifi.site_settings({'router': {'host': 'gateway.example.lan'}}, {})[1]), 3, 'a host name has no /24: private ranges')
  self.assertEqual(unifi.site_settings([] if False else {'lanCidrs': 'x', 'machines': 'y', 'router': 'z'}, {})[0], '192.168.1.1', 'wrong shapes are ignored')
  with tempfile.TemporaryDirectory() as tmp:
   root = pathlib.Path(tmp)
   (root / 'site.json').write_text(json.dumps(site))
   self.assertEqual(unifi.load_site({'HOME_HUB_SITE_CONFIG': str(root / 'site.json')})['router']['site'], 'home')
   self.assertEqual(unifi.load_site({'HOME_HUB_SITE_CONFIG': 'none'}), {})
   self.assertEqual(unifi.load_site({'HOME_HUB_SITE_CONFIG': str(root / 'missing.json')}), {})
   (root / 'app').mkdir(); (root / 'data').mkdir()
   self.assertEqual(unifi.default_root({}, root / 'app'), root, 'deployed as <root>/app beside data/')
   self.assertEqual(unifi.default_root({}, root / 'data'), root / 'data', 'otherwise the checkout itself')
   self.assertEqual(unifi.default_root({'HOME_HUB_ROOT': '/srv/hub'}, root), pathlib.Path('/srv/hub'))
   self.assertEqual(unifi.default_root({'HOME_HUB_HOME': str(root)}, root / 'data'), root.resolve(), 'an instance directory holds data/ and router-private/')
   self.assertEqual(unifi.default_root({'HOME_HUB_ROOT': '/srv/hub', 'HOME_HUB_HOME': str(root)}, root), pathlib.Path('/srv/hub'), 'HOME_HUB_ROOT wins')
   (root / 'config').mkdir(); (root / 'config/site.json').write_text(json.dumps({'router': {'site': 'inst'}}))
   self.assertEqual(unifi.load_site({'HOME_HUB_HOME': str(root)}, root / 'data')['router']['site'], 'inst', 'the instance configuration')
   self.assertEqual(unifi.load_site({'HOME_HUB_CONFIG_DIR': str(root)}, root / 'data')['router']['site'], 'home', 'a configuration directory of its own')
   self.assertEqual(unifi.load_site({'HOME_HUB_SITE_CONFIG': 'none', 'HOME_HUB_HOME': str(root)}), {}, 'none still means none')
 def test_several_networks(self):
  saved = unifi.LANS
  try:
   unifi.LANS = [unifi.ipaddress.ip_network('10.0.0.0/24'), unifi.ipaddress.ip_network('10.0.20.0/24')]
   self.assertEqual([unifi.lan_ip(x) for x in ('10.0.0.5', '10.0.20.7', '10.0.20.255', '10.0.0.0', '10.0.30.1', 'x')], ['10.0.0.5', '10.0.20.7', None, None, None, None])
  finally: unifi.LANS = saved
 def test_failure_keeps_previous_snapshot(self):
  with tempfile.TemporaryDirectory() as tmp:
   root = pathlib.Path(tmp); (root / 'data').mkdir()
   previous = {'schemaVersion': 1, 'source': 'ASUS SSH', 'status': 'ok', 'observedAt': '2026-10-30T08:49:01+00:00', 'devices': [{'mac': 'aa:bb:cc:dd:ee:ff', 'ip': '10.0.0.9', 'name': 'x', 'connection': 'Unknown', 'presence': 'lease-only'}]}
   (root / 'data/router-observations.json').write_text(json.dumps(previous))
   saved = (unifi.PRIVATE, unifi.KEY_FILE, unifi.PIN_FILE, unifi.TARGET)
   unifi.PRIVATE, unifi.KEY_FILE, unifi.PIN_FILE, unifi.TARGET = root / 'router-private', root / 'router-private/unifi-api-key', root / 'router-private/unifi-cert-sha256', root / 'data/router-observations.json'
   try:
    snapshot = unifi.collect()
    self.assertEqual((snapshot['status'], snapshot['error'], snapshot['observedAt'], snapshot['devices']), ('unavailable', 'certificate-not-pinned', previous['observedAt'], previous['devices']))
    written = json.loads(unifi.TARGET.read_text()); self.assertEqual(written['status'], 'unavailable'); self.assertTrue(written['attemptedAt'] > previous['observedAt'])
    self.assertEqual(stat.S_IMODE(unifi.TARGET.stat().st_mode), 0o600)
   finally: unifi.PRIVATE, unifi.KEY_FILE, unifi.PIN_FILE, unifi.TARGET = saved
if __name__ == '__main__': unittest.main()
