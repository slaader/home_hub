# Storage

Everything Home Hub keeps is a file on the machine that runs it, under its state and data directories (`STATE_DIR`, `DATA_DIR`).

| Where | What | Format |
|---|---|---|
| `state/hub.db` (+ `-wal`, `-shm`) | Tickets (projects, releases, tickets with comments and history), the review index (sets → rounds → items → feedback, blob metadata), browser sign-in sessions, the full-text search index | SQLite, `node:sqlite` built into Node, no npm package |
| `state/review/blobs/` | Review files (mockups, images, `.glb`), content-addressed by sha256 | files |
| `state/access.json`, `state/device-tokens.json` | Users and their roles, custom roles, service accounts, API keys, per-account preferences, device tokens (hashes only) | JSON |
| `state/compute/`, `state/thermo/` | Telemetry history, one line per sample | JSONL, monthly files |
| `state/*-audit.jsonl` | Audit logs | JSONL |
| `data/` | Inventory (`knowledge.json`), collector output | JSON |
| `private/` | `auth.json` (the owner's hash and `passwordAt`; written by `scripts/setup.mjs`), TLS key, tokens | JSON / PEM |

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

Back the state directory up with Home Hub stopped: the database is then closed and consistent, and the
`-wal` file, if present, is copied with it. Do not copy `hub.db` from a running server with `cp`. Use
`sqlite3 state/hub.db ".backup /path/copy.db"` instead.

A deploy (`scripts/deploy-mini-server.sh` on the mini) restarts the service in place. `state/` is gitignored, so
pulling code never touches the database, and sessions survive the restart.
