# Git LFS view

Inventory → Git LFS (`#git-lfs`, core module `git-lfs`) lists the Git LFS objects of repositories on git hosts the hub
connects to over their HTTP API and git. For each object it shows the size, the file paths that point to it, the refs
whose tip has it, the first and last commit, and a status:

| Status | Meaning |
|---|---|
| `current` | A file on the default branch's tip points to it (the page says "On main") |
| `branch` | The default branch's tip does not, but the tip of another branch or tag does: freed only by deleting those refs |
| `history` | Only older commits (reachable from some ref) point to it; no tip does |
| `orphaned` | No commit reachable from any ref points to it, and the host is known to still store it |

This is separate from the household plugin `lfs` (`/api/lfs*`, scope `lfs:delete`), which reads one Forgejo straight
from its database and bare repositories on disk. This feature does not change that plugin and uses other paths and
another scope.

Code: `server/core/git-lfs.mjs` (module, routes, integration), `server/git-lfs-store.mjs` (connections, tokens,
catalog, deletion), `server/git-lfs-git.mjs` (mirror and scan), `server/git-lfs-providers.mjs` (hosts),
`public/git-lfs-view.js`, `public/git-lfs-wizard.js`. Tests: `tests/git-lfs.test.mjs`, `tests/git-lfs-dom.test.mjs`
(a fake host on 127.0.0.1 serving real git over `git http-backend`, `tests/support/git-host.mjs`).

## What the hosts allow

Checked against the official docs and API specs on 2026-11-11. **None of these hosts has an API that lists a
repository's LFS objects or deletes one.** All of them serve the Git LFS batch API, which tells you whether the host
still stores a given object. So the built-in providers are read-only:

| | List repos | Check an object (batch API) | List LFS objects | Delete an LFS object | Token scopes readable |
|---|---|---|---|---|---|
| GitHub / GitHub Enterprise Server | yes | yes | **no** | **no**: delete and recreate the repository, or ask GitHub Support | classic tokens (`X-OAuth-Scopes`); fine-grained: no |
| Gitea | yes | yes | **no** (web UI only: Settings → LFS) | **no** (web UI only; server cron `gc_lfs`) | `GET /api/v1/token`, Gitea 1.27 and later |
| Forgejo | yes | yes | **no** (web UI only) | **no** (web UI only) | no |
| GitLab (not built in) | yes | yes | no (only a total size) | no (repository cleanup in the UI) | `GET /api/v4/personal_access_tokens/self` |

Sources:
- Git LFS batch API: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md (only `download`/`upload`, no delete)
- GitHub: https://docs.github.com/en/rest/repos/lfs (enable or disable LFS only),
  https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage,
  https://docs.github.com/en/rest/repos/repos, https://docs.github.com/en/rest/users/users,
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps,
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens,
  https://docs.github.com/en/enterprise-server@3.16/rest/quickstart (`https://HOST/api/v3`)
- Gitea: https://docs.gitea.com/api (spec at https://gitea.com/api/swagger; LFS appears only as `GET …/media/{path}`),
  https://docs.gitea.com/development/api-usage, https://docs.gitea.com/administration/git-lfs-setup
- Forgejo: https://codeberg.org/api/swagger, https://forgejo.org/docs/latest/user/api-usage/,
  https://forgejo.org/docs/latest/user/token-scope/
- GitLab: https://docs.gitlab.com/user/project/repository/repository_size/, https://docs.gitlab.com/api/personal_access_tokens/,
  https://docs.gitlab.com/security/tokens/access_token_scopes/

What this means in practice:

- **Orphans** are found without a listing API. An object is a candidate when no reachable commit points to it, and
  either the hub saw it referenced in an earlier scan or the mirror still holds its pointer (after a force-push or a
  deleted branch). The batch API then confirms whether the host still stores it. An object that was uploaded and
  never referenced in anything the hub saw stays invisible on these hosts.
- **Deleting** on GitHub, Gitea and Forgejo is not possible from the hub. The page marks reclaimable objects (past the
  grace period, storage confirmed) and links to where to remove them by hand: the Gitea/Forgejo
  `/{owner}/{repo}/settings/lfs/show/{oid}` page, or the GitHub doc.
- A provider added by a plugin may list and delete (for example a household host with its own store). The deletion
  path below is built for that and tested with such a provider.

## Tokens

The wizard shows these lines and links to the place where you create the token. A read-only token is enough.

| Provider | Permissions | Where |
|---|---|---|
| GitHub | Fine-grained: Repository access (selected or all), **Contents: Read-only** (Metadata: Read-only comes with it). Classic: `repo`, or `public_repo` for public repositories only | https://github.com/settings/personal-access-tokens/new (Enterprise: `https://HOST/settings/personal-access-tokens/new`) |
| Gitea | `read:repository`, `read:user`; `read:organization` to list an organization's repositories | `https://HOST/user/settings/applications` |
| Forgejo | as Gitea. A token limited to specific repositories carries only repository and issue scopes | `https://HOST/user/settings/applications` |

The token is stored server-side only, in `private/git-lfs-tokens.json` (0600; `GIT_LFS_TOKENS_FILE` overrides the
path). It is never returned, logged or written to the mirror. A stored token is sent only to the host it was entered
for: changing a connection's provider or address requires a new token. git gets it as an `http.extraHeader` through
`GIT_CONFIG_*` environment variables, never on the command line and never in a URL. Credential helpers, the user's and
the system's git configuration, redirects and every protocol except http(s) are switched off for these git processes.
API calls never follow redirects, and the clone URL is built from the connection's address, never taken from the API
answer.

## Scanning

For each repository the hub keeps a bare, partial mirror under `<state>/git-lfs/<connection>/mirrors/<owner>/<name>.git`:
`git clone --mirror --filter=blob:limit=1024`, then `git fetch --prune --prune-tags`. git-lfs never treats a blob of
1024 bytes or more as a pointer, so every pointer arrives and no large content does. git-lfs is not needed: pointers
are parsed by the hub. If a host ignores the filter, the clone simply takes longer.

A scan reads only the mirror and never fetches (`GIT_NO_LAZY_FETCH`, `--missing=print`):

1. `for-each-ref`: the host's refs (all of them, `refs/pull/*` included). Their hash is the scan's revision.
2. `cat-file --batch-all-objects`: every blob under 1024 bytes, parsed. A blob that names an `oid sha256:` the way a
   pointer does but is not a valid pointer still counts as a reference (it protects that object).
3. `rev-list --objects --all`: which pointer blobs are reachable. This is the authoritative check.
4. `log --all --source --raw`: the paths, commits and refs each pointer was reached through.
5. `ls-tree -r` of the default branch and of every branch and tag tip (up to 500): which tips contain each object.

Any git error, cut-off output or output over its limit fails the scan for that repository (`state: error`). Nothing in
that repository can then be deleted until a scan completes. A scan also counts as incomplete (`incomplete`) when the
host advertises no refs at all, or not the default branch it names, while the hub knows of objects in that
repository. Such an answer (a token that suddenly sees nothing, a host in trouble) would otherwise make every object
look orphaned. An empty repository that stores nothing is complete.

**Assumption about missing blobs.** In a partial mirror, `rev-list --missing=print` lists reachable blobs the host
did not send. The scan assumes every one of them is 1024 bytes or larger: such a blob cannot be a pointer
(git-lfs's cutoff), so it cannot protect an LFS object. This holds because the host applies
`--filter=blob:limit=1024`, which sends every smaller blob. A host that ignores the filter sends everything, which is
also fine. A host that honours the filter but drops small blobs it should send would break this assumption, and
pointers in those blobs would go unseen. No such host is known; the hub cannot detect one without downloading the
missing blobs. Catalogs are kept per connection in
`<state>/git-lfs/<connection>/catalog.json`, together with when each object was first seen, last seen, last referenced
and unreferenced since. They refresh when a connection is saved, on request (`POST /api/git-lfs/refresh`, at most once
every 30 s per connection), and every 6 hours from the poller. Any signed-in person who can read may ask for a scan.
An API key needs `git-lfs:write` for it, so a read-only key in a script cannot keep the hub fetching. A scan of a
single repository does not count as the 6-hourly full scan.

## Deletion rules

An object can be deleted only when **all** of these hold. Each is checked again right before deleting:

1. Its status is `orphaned`: no commit reachable from any ref points to it. `current`, `branch` and `history` objects are never
   deleted. Freeing history would need a history rewrite, and the hub does not do that.
2. The host confirmed that it stores it (listed by the provider, or `download` in the batch API).
3. The repository's last scan completed, and its storage check did not fail.
4. The grace period has passed since the latest of: when the object was first seen unreferenced, when it
   was uploaded (when the provider says), and when it was last referenced.
5. The provider declares `deleteObjects` (and `listObjects`).
6. No other repository of a connection on the same host references it.

The flow: `POST /api/git-lfs/delete/preview` returns, per repository, the eligible objects with their paths and sizes,
the refused ones with the reason, and the revision. `POST /api/git-lfs/delete` with `{connection, repo, oids, revision,
requestId}` then:

- refuses (`409 GIT_LFS_CONFLICT`) when the catalog's revision is not the preview's;
- scans the repository again, now: fetch, git scan, the host's listing. A failure is `503 GIT_LFS_UNVERIFIED` and
  nothing is deleted;
- refuses when the fresh revision differs (a ref or the stored list changed), so the person reviews it again;
- checks every object against rules 1–6 once more, then deletes the eligible ones one by one. It appends to
  `<state>/git-lfs/audit.jsonl` (0600) a `started` line before each deletion and a `deleted` or `failed` line after.
- reads the host's refs again (`git ls-remote`, nothing fetched) before every 25 deletions. If they changed (a push
  after the re-scan) or cannot be read, the rest is not deleted: `stopped: refs-changed | refs-unverified`, and the
  rest is listed in `refused` with that reason. After the last deletion the refs are read once more;
  `refsChangedDuring: true` reports a change that came too late to stop anything.
- stops when an audit line cannot be written: before the object when the `started` line fails, after it when the
  result line fails. The answer is still `200` with what was deleted, `stopped: audit-failed`, and the rest in
  `refused`.
- computes the revision again without the deleted objects, so the next preview and deletion match the host.

One deletion or scan runs per connection at a time (`409 GIT_LFS_BUSY` otherwise). The same `requestId` sent again
returns the first answer without deleting anything twice. At most 500 objects go in one request. The page's bulk
action previews everything that matches the filters and sends one request per repository.

The grace period is **7 days** by default, as long as Gitea's own LFS garbage collection waits.
`GIT_LFS_GRACE_HOURS` in the server's environment changes it (whole hours, at least 1).

### What a provider's `deleteObject` must do

The hub sees only the repositories its connections cover. Forks, mirrors and repositories outside the selection are
invisible to it. Rule 6 protects only against repositories the hub has scanned. So `deleteObject(ctx, repo, oid)`
must remove **only this repository's association** with the object: Gitea and Forgejo keep a per-repository LFS
record and delete the content only when no record is left. A provider must never delete content that another
repository, a fork or an object network can still point to. If the host cannot remove one repository's association
alone, the provider must not declare `deleteObjects`. GitHub's storage is shared across a fork network, which is one
reason it has no such call.

## Providers

A provider is a plain object (`server/git-lfs-providers.mjs` has the shape and the three built-ins). A plugin adds one
through the extension point `git-lfs.providers`: `provides: {'git-lfs.providers': (state, hub) => [provider]}`.

```js
{id: 'gitlab', title: 'GitLab',
 capabilities: {listRepos, checkObjects, listObjects, deleteObjects, tokenScopes},   // booleans, all required
 fixedBaseUrl: 'https://gitlab.com' | null,
 endpoints(baseUrl) → {api, web},                  // throw for a URL it cannot use
 token: {url(web) → string, steps?: [line] (where to click to make the token; shown in the wizard and on the empty page), permissions: [line], note},
 whoami(ctx) → {login, name, scopes | null, scopesNote, warnings},
 listRepos(ctx, {owner}) → [{owner, name, fullName, defaultBranch, private, archived}],
 getRepo(ctx, fullName) → one of those,
 gitAuth(ctx) → {username},                        // user name sent with the token (basic auth) to git and LFS
 listObjects?(ctx, repo) → [{oid, size, createdAt}],  // the complete list, or throw
 deleteObject?(ctx, repo, oid),                    // throw on failure
 manual(web, repo, oid) → {text, url}}             // how a person removes an orphan by hand
```

`ctx` holds `api`, `web`, `token`, `login` and the ready `authHeader`/`gitAuthHeader`. Use `apiRequest(ctx, …)` from
the same file: it does not follow redirects, refuses URLs outside `api`/`web`, bounds the body and maps failures to
codes. A GitLab provider would need `endpoints` (`/api/v4`), `whoami` (`/user` plus `/personal_access_tokens/self`),
`listRepos` (`/projects?membership=true`, `/groups/:id/projects`) with `fullName` `group/project` (nested groups need
a wider name rule than the current `owner/name`), and `gitAuth` → `oauth2`.

## Integration

`git-lfs.hosts` on Administration → Integrations. When it is off, the hub contacts no host, the poller skips its work,
reads answer `{disabled}` and every change is refused with `409`. The card shows one item per connection.

## Known limitations

- No built-in host can be pruned from the hub (see the table above). Orphans that were uploaded but never referenced
  in anything the hub saw are not detected on read-only hosts.
- The hub sees only the refs the host advertises. Unreachable commits the host still keeps (its reflog, objects that
  have not been garbage-collected) are invisible, so an object only they reference counts as orphaned.
- Between the final check and the delete call, a push can still start using the object. The re-scan narrows this
  window but cannot close it without a lock on the host's side.
- Tips are read for the default branch and up to 500 other branches and tags (`stats.tipsSkipped` counts the rest).
  An object only at a skipped tip shows as `history` instead of `branch`.
- `via` names one ref per commit (the one git reached it from first), not every branch that contains the commit.
- At most 200 repositories per connection. The batch check covers up to 2000 objects per repository per scan
  (orphan candidates first); objects past that limit show storage as unknown.
- A host that redirects git or API requests (to another hostname, or from http to https) is refused. Use its final
  address.

## Accepted risk: the hub calls addresses people type in

The base URL of a connection is any http(s) address that someone holding `git-lfs:write` enters. Testing,
listing, saving and scanning make the **hub's server** send requests there, git included, with the token that was
entered. That is server-side request forgery by design: the holder can point the hub at addresses on its own network
(a router's admin page, a loopback service). What limits it:

- The answers go back only as parsed fields (a login, a list of names, error codes such as `auth` or `not-found`),
  never as raw bodies. git output is never returned.
- Only GET to the API, the LFS batch POST and git's read-only `upload-pack` are sent. No redirect is followed.
- A stored token is sent only to the host it was entered for. Changing the address needs a new token, so a stored
  token cannot be sent to an address of the editor's choosing.
- `git-lfs:write` is not given to old write keys (`legacy: false`). The Editor role and the Admin role have it.

Give `git-lfs:write` only to people and keys you would trust to make requests from the hub's machine. There is no
allowlist of hosts.
