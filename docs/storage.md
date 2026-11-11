# Storage

Everything Home Hub keeps is a file on the machine that runs it, under its state and data directories (`STATE_DIR`, `DATA_DIR`).

| Where | What | Format |
|---|---|---|
| `state/hub.db` (+ `-wal`, `-shm`) | Tickets (projects, releases, tickets with comments and history), the review index (sets → rounds → items → feedback, blob metadata), browser sign-in sessions, the full-text search index | SQLite, `node:sqlite` built into Node, no npm package |
| `state/review/blobs/` | Review files (mockups, images, `.glb`), content-addressed by sha256 | files |
| `state/access.json`, `state/device-tokens.json` | Users and their roles, custom roles, service accounts, API keys, per-account preferences, device tokens (hashes only) | JSON |
| `state/compute/`, `state/thermo/`, `state/windows/`, `state/linux/` | Telemetry history, one line per sample (`windows/`: Windows over SSH or WinRM; `linux/`: Node Exporter, Prometheus or SSH; a device that switches within a family keeps its history) | JSONL, monthly files |
| `state/home/` | Machines added on the overview (`devices.json`), their telemetry logins (`thermo-hosts.json`), Windows SSH connections (`windows-hosts.json`) and the other agent-less connections (`telemetry-hosts.json`: WinRM, Node Exporter, Prometheus, Linux SSH; holds the WinRM password, a Node Exporter's Basic password and a Prometheus password or bearer token; **this file and `thermo-hosts.json` are sealed**, see Secrets at rest), and which machines of the site configuration are read through one of them (`site-telemetry.json`: id, provider, platform, who and when; no secrets; their connections are in the two files above under the same id; `site.json` is never written), and the owner's display edits of those machines over the site's values (`site-overrides.json`: name, hostname, ip, hardware, picture, who and when; their uploaded picture in `images/`), all 0600 | JSON |
| `state/home/ssh/` | **Private SSH keys** of the hub's Windows and Linux SSH connections, each connection's verified host key, an empty ssh configuration (directories 0700, files 0600; on Windows an ACL for the hub's account and SYSTEM only) | PEM / OpenSSH text |
| `state/backup-jobs/` | Backup jobs (`jobs.json`, 0600), per job `<id>/runs.json` (≤ 200 runs, the last snapshot listing and free space), `<id>/logs/<run>.log` (≤ 256 KiB each), `<id>/run.lock`, and `<id>/staging/` (the hub's mirror of a source on another machine) | JSON / text |
| `state/*-audit.jsonl` | Audit logs | JSONL |
| `data/` | Inventory (`knowledge.json`), collector output | JSON |
| `private/` | `auth.json` (the owner's hash and `passwordAt`; written by `scripts/setup.mjs`), TLS key, tokens; `backup-jobs/<id>/` (0700): each backup job's ed25519 key pair (private key 0600), its generated `ssh_config` and `known_hosts` with the pinned host keys | JSON / PEM |

## hub.db

`server/db.mjs` opens one connection per process (WAL mode, `0600`). The stores keep their document model:

- `docs(kind, coll, id, doc)`: one JSON document per ticket, release, project, review set or blob, plus
  `meta(kind, doc)` for the counters (`revision`, `next`). A write runs the store's validation on the loaded
  document, then saves **only the rows that changed** and their search entries in one transaction. A
  validation error writes nothing. Optimistic `rev` checks and the per-store write queue are unchanged.
- `sessions(hash, user_id, password_at, until)`: the SHA-256 of each `homehub` cookie token, never the token.
  Sessions expire 12 hours after sign-in and end when the user's `passwordAt` moves (password change or reset).
- `search`: an FTS5 table (`unicode61 remove_diacritics 2`, prefix indexes) filled by the stores. Bump
  `SEARCH_VERSION` in `db.mjs` when the indexed text changes; the index is rebuilt at the next start.
  Readers: `db.search({q,kind,project,limit})` (plain words, each a prefix; a query that is an id ranks that
  record first), `db.searchStats()` (documents per kind, so a client can tell an empty index from no match) and
  the ticket store's `search()`, which filters the hits by ticket fields. None of them changes the schema.
- `PRAGMA user_version` is the schema version. Newer code migrates forward; older code refuses a newer file
  rather than misreading it.

Query by hand (read-only is enough; the server may keep running):

```bash
sqlite3 -readonly state/hub.db "select id, json_extract(doc,'$.title') from docs where kind='tickets' and coll='tickets'"
sqlite3 -readonly state/hub.db "select kind, id, title from search where search match '\"prihlas\"*'"
```

## Migration from the JSON files

On first use each store imports its old file once, `state/tickets/tickets.json` and `state/review/review.json`,
then renames it to `*.migrated`. A file that does not parse or has the wrong shape is refused and left untouched,
and the store does not start with an empty tracker. To roll back to code from before hub.db: stop Home Hub, rename the
`*.migrated` files back (any change made since lives only in hub.db) and deploy the older commit.

## Backups

A backup of the state directory contains `state/home/ssh/`, the private keys the hub signs in to Windows with.
Keep it as private as `private/`. Restoring without it leaves those connections failing with `key-missing`
until a key is created again in the device dialog (and authorized on Windows).

Back the state directory up with Home Hub stopped: the database is then closed and consistent, and the
`-wal` file, if present, is copied with it. Do not copy `hub.db` from a running server with `cp`. Use
`sqlite3 state/hub.db ".backup /path/copy.db"` instead.

A deploy (`scripts/deploy-mini-server.sh` on the mini) restarts the service in place. `state/` is gitignored, so
pulling code never touches the database, and sessions survive the restart.

### Secrets at rest

`state/home/thermo-hosts.json` (Thermo logins) and `state/home/telemetry-hosts.json` (WinRM, Node Exporter and
Prometheus passwords and tokens) are **sealed**: AES-256-GCM over the whole document, the file's purpose bound in as
additional data (`server/secret-box.mjs`). A copy of `state/` (a backup, a bundle, a mistaken commit) holds no
usable secret. The key is kept apart from the data; new files are sealed with the first source that applies:

1. `HOME_HUB_SECRET_KEY`: 64 hex characters (containers, a service manager's secret store, tests);
2. the macOS login **Keychain**, only with `HOME_HUB_SECRET_KEYCHAIN=1`: generic password, service `Home Hub`,
   account `secret-key`, handed to `security -i` on stdin (never on a command line). It needs the login keychain
   unlocked, which a LaunchDaemon after a reboot may not have; that is why it is not the default;
3. a **key file**: `HOME_HUB_SECRET_KEY_FILE`, else `secret.key` next to `AUTH_FILE` (`private/secret.key` by default;
   a preview with its own `AUTH_FILE` gets its own key and never sees the production one). 0600, created on first use,
   exclusively through a hard link (two processes agree on one key; a filesystem without hard links reports
   `SECRETS_LOCKED`: set `HOME_HUB_SECRET_KEY` there).

Nobody has to handle the key: the hub makes it, seals and opens with it. It lives in `private/` next to the
sign-in file, so updates, deploys and restarts never touch it, and a reinstall that keeps `private/` keeps it.

A sealed file is opened with the key of the source it names (`kid`) first, then with any other key that is there.
Each file also carries a fingerprint of its key (`kfp`, 64 bits of a hash; nothing about the key itself), and
`state/home/secret-key.json` records the fingerprints of the key files the files there were sealed with (the last 16)
and the key file in use; it is written before the sealed file.

When no key opens a file:

- **Reading** (pollers, dialogs) treats it as empty: its devices show "no login". The file is not touched, so a key
  that comes back (a volume mounted late, `private/` restored) makes everything work again.
- **The SSH key sweep** is skipped while the file cannot be read, so no SSH key is deleted meanwhile.
- **Saving or removing a login** sets the file aside (`<name>.lost-<time>`, never deleted) and goes on with a new key,
  but only when the loss is certain: the file was sealed with a key file the marker knows, no key file holds that
  key, and either the key file in use is the marker's and its directory is there (a reinstall that kept `state/` but
  not `secret.key`) or the marker's key directory is gone altogether (the hub moved). The owner then just enters the
  password again; the other file, sealed with the same lost key, goes aside the same way on its first change. In
  every other case (a launch with another key path while the marker's directory is still there, an unmounted volume,
  a locked or turned-off Keychain, another `HOME_HUB_SECRET_KEY`, a damaged file) nothing moves and the change is
  refused with `503 SECRETS_LOCKED` until the key is back.

A plain file from an older hub (or one sealed before files named their key) is read as before and sealed again on
first read (retried every ten minutes while no key can be made).

- Moving a hub to another machine with its passwords: carry `private/` along (or set the key as `HOME_HUB_SECRET_KEY`
  there). Without it the devices just need their passwords again.
- A container with a read-only `private/` cannot make its key: create it outside (`openssl rand -hex 32`, 0600, owned
  by the container's user) or pass `HOME_HUB_SECRET_KEY`.
- Sealing protects copies of the files (confidentiality). Someone who can already write `state/home/` as the hub's
  account can also put a plain file there; that is outside what it defends against.
- Older backups or snapshots of `state/` taken before sealing still hold these passwords in plain text: change
  those passwords, or delete those copies.
- Not sealed (yet): the SSH private keys in `state/home/ssh/` and `private/backup-jobs/` (OpenSSH reads them as
  files), `private/integrations.json` and `private/git-lfs-tokens.json`. They rely on the file permissions below.

Home-device state files use owner-only permissions: POSIX mode 0600 under a 0700 directory; on Windows, an explicit DACL permits only the Home Hub account and SYSTEM. New files are protected before the atomic rename, including `telemetry-hosts.json` passwords and tokens.
