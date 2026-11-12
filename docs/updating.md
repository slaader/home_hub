# Updating

Home Hub never updates itself. It tells you that a newer release exists (the card "Home Hub update check" on
Administration → Integrations, and the footer for an administrator); **a command applies it**, run on the server by
whoever may restart the service:

```sh
node scripts/update.mjs status              # what is installed and running, the newest tag, the last update
node scripts/update.mjs preflight v1.3.0    # every check that needs no change to the instance
node scripts/update.mjs apply v1.3.0        # preflight, stop, archive, switch, start, health check; back on any failure
node scripts/update.mjs rollback            # undo the last update
node scripts/update.mjs backup              # only the archive (stop, archive, start)
```

Without a tag, `preflight` and `apply` take the newest release tag after a fetch. `--to v1.3.0` is the same as the
bare tag. There is no button and no MCP tool for any of this, on purpose: the hub holds SSH keys and tokens for other
machines, and a web request that can replace its code would turn a stolen session into code execution with them.

This page is for a hub that runs from a git checkout. A container is rebuilt instead: [docker.md](docker.md).

## Tell it about your installation

The command has to know three things that are not in the code: where the instance's files are, how its service is
stopped and started, and where it answers.

**With an instance directory** (`HOME_HUB_HOME`, [storage.md](storage.md)) they are in `<home>/instance.json`, next to
the plugin sources that file already names:

```json
{"schemaVersion": 1,
 "sources": {"core": "core", "plugins": ["household"]},
 "service": "launchd:system/com.example.home-hub",
 "health": {"url": "http://127.0.0.1:8781/healthz", "seconds": 60},
 "backups": {"keep": 5}}
```

```sh
HOME_HUB_HOME=/srv/home-hub node /srv/home-hub/core/scripts/update.mjs apply
```

**With everything in the checkout** (the default layout) they are flags, the same on every call:

```sh
node scripts/update.mjs apply v1.3.0 \
  --service launchd:system/com.example.home-hub \
  --health http://127.0.0.1:8781/healthz
```

| What | `instance.json` | Flag | Default |
|---|---|---|---|
| The core checkout | `sources.core` (a directory of the instance) | `--root DIR` | the checkout this script is in |
| Plugin sources | `sources.plugins` | (`HOME_HUB_PLUGINS_DIR`) | `local/plugins` in the checkout |
| The service | `service` | `--service SPEC` | none: `apply`, `rollback` and `backup` refuse without it |
| Where it answers | `health.url`, `health.seconds` | `--health URL`, `--health-seconds N` | none; 60 s |
| Archives | `backups.keep` | `--backups DIR`, `--keep N` | `<home>/backups`, else `<checkout>/backups`; the newest 5 |
| Instance directory | | `--home DIR` or `HOME_HUB_HOME` | none |
| Data, state, secrets | | `--data`, `--state`, `--private`, or `DATA_DIR`, `STATE_DIR`, `HOME_HUB_PRIVATE_DIR` | as the server resolves them |

A flag wins over `instance.json`. **The paths must be the ones the service runs with**: when its unit sets `STATE_DIR`
or `DATA_DIR`, give the command the same values. It checks this before it touches anything: an `apply` refuses unless
`<state>/run.json` exists, names a live process of the installed version, and the health address answers.

`service` is one of:

| Form | Stop | Start |
|---|---|---|
| `launchd:system/<label>` | `launchctl bootout system/<label>` | `launchctl bootstrap system /Library/LaunchDaemons/<label>.plist` |
| `launchd:gui/<uid>/<label>` (or `user/<uid>/…`) | `launchctl bootout gui/<uid>/<label>` | `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/<label>.plist` |
| `systemd:<unit>` | `systemctl stop <unit>` | `systemctl start <unit>` |
| `systemd-user:<unit>` | `systemctl --user stop <unit>` | `systemctl --user start <unit>` |
| `{"stop": ["…"], "start": ["…"]}` (as a flag: `command:{"stop":[…],"start":[…]}`) | the first command | the second |

A system service (`launchd:system/…`, `systemd:…`) is driven through `sudo -n` unless the command runs as root, so
the account needs a sudoers rule for exactly those commands. Commands run without a shell. The health address is the
hub's own `/healthz` on its local port, not the reverse proxy in front of it.

## What `apply` does

| # | Step | If it fails |
|---|---|---|
| 1 | Takes the lock. Refuses while an earlier update is unfinished. | stops |
| 2 | Checks that the hub is running the installed version and that the health address answers. | stops |
| 3 | `git fetch --tags`; resolves the target. Refuses a lower version, a tag whose `package.json` says another version, a checkout with changed tracked files, a release that was rolled back here before (`--force` tries again), and, when the installed checkout has `config/release-signers`, a tag without a good signature (`--allow-unsigned`). | stops |
| 4 | Checks out the target in a scratch worktree (`<home>/staging/`, else the temp directory), with every plugin source beside it. From those files: each plugin's `core` range must include the target version, each `requires` must be met, the Node version must fit, and the data epoch is compared. | stops, naming the plugin |
| 5 | In the scratch worktree: the target's `npm test`, the plugin sources' tests against the target core, then `node server/index.mjs --check` with **this instance's** site file, secrets and plugins. The worktree is removed. | stops; nothing was touched |
| 6 | Writes the journal, stops the service, waits for its process to exit. | starts it again |
| 7 | Archives `config/` (an instance directory), `data/`, the state directory and `private/` into `pre-<from>-to-<to>-<time>.tgz` (0600) and lists it back. The hub is stopped, so the SQLite file is closed and consistent. A backup job's `staging/` mirror and `*.tgz` files are left out. | starts the old version |
| 8 | `git checkout --detach <tag>` in each source that changes. | rolls back |
| 9 | Starts the service. Within `health.seconds` the health address must answer **and** `run.json` must show the target version, a live process started after the switch, and the expected plugins with their versions. | rolls back |
| 10 | Marks the journal done, appends to `<state>/update-history.jsonl`, removes archives beyond `backups.keep`. | |

After an update the checkout is on a detached tag, not on a branch: `git pull` no longer applies, the next update is
another `apply`.

**Rolling back** (automatic from step 6 on, or `rollback` later) stops the service, switches each source back to the
commit it was on (and onto its branch, when that branch still names that commit), starts it, and runs the same health
check for the old version. A release that failed is noted in `<state>/updates.json → quarantined`; the update card
then says "tried on … and rolled back", and `apply` refuses it without `--force`. An update that was only interrupted
(Ctrl-C, a lost session) is put back without that note. If the old version does not come up either, the command
stops, leaves the service **stopped**, exits 3 and prints the journal, the archive and the history file. It does not
loop; `rollback` tries again once the cause is fixed.

Exit codes: 0 done; 1 refused, or failed and put back; 2 usage; 3 the rollback failed.

## The data epoch: when going back needs the archive

State migrates forward when newer code first opens it, and older code refuses newer state. `package.json →
homeHub.dataEpoch` (and a plugin's `plugin.json → dataEpoch`) rises in any release that changes a format on disk; the
changelog says so under **Data**. The preflight states which case this is:

| From → to | Going back |
|---|---|
| Same epoch (every patch, most minors) | The code switches back. Nothing written since is lost. |
| The epoch rose | The code switches back **and the pre-update archive is restored**. Everything written after the update is lost. The directories it replaces are moved to `<backups>/failed-<time>/`, never deleted. |

An automatic rollback restores without asking (the new version ran for seconds). A later `rollback` after a rise
needs `--yes`, and refuses when the archive is gone.

## Plugin sources

A plugin source that is a git checkout of its own (an instance's `sources.plugins`) is switched in the same
transaction, by its own tag: one preflight, one archive, one restart, one rollback.

```sh
node scripts/update.mjs apply v1.3.0 --plugins v1.1.0            # core and the only plugin source
node scripts/update.mjs apply --plugins household=v1.1.0         # only that source; core stays
```

The core range check holds in every combination: a plugin that does not support the target core stops the preflight
with its name, and so does a plugin tag that needs a newer core than the one installed. Plugins inside the checkout
(`local/plugins`) travel with it; when they are not tracked there, they are copied into the scratch worktree for
the checks.

## An interrupted update

The journal (`<home>/update-journal.json`; without an instance directory `<checkout>/backups/update-journal.json`)
is written before every step. If the command dies, `status` says `UNFINISHED`, and the next `apply` or `rollback`
first puts the previous version back from the journal: nothing new is applied in that run. A second update cannot
start meanwhile (`update.lock`, replaced when its process is gone).

## The first update of a release that has no update command

1.1.0 and older have no `scripts/update.mjs`. Run the new release's copy against the old checkout with `--root`:

```sh
cd /srv/home-hub && git fetch --tags
git worktree add --detach /tmp/home-hub-updater v1.2.0
node /tmp/home-hub-updater/scripts/update.mjs apply v1.2.0 --root /srv/home-hub --service … --health …
git worktree remove /tmp/home-hub-updater
```

## Rehearsing the rollback

Worth doing once per installation: it proves that the service commands, the health address and the paths are right
before a real release depends on them. Make a local tag that passes its tests and exits when started, apply it, watch
it come back, delete the tag. Nothing is pushed. The tag carries a version that will never be released (here
`1.2.999`: a plain version, because a pre-release such as `1.2.1-rc.1` is outside every plugin's core range and would
fail the tests instead of the start).

```sh
cd /srv/home-hub
git worktree add --detach /tmp/hub-rehearsal v1.2.0 && cd /tmp/hub-rehearsal      # the release that is installed
sed -i.bak 's/"version":"1.2.0"/"version":"1.2.999"/' package.json && rm package.json.bak
awk '!d&&/^## /{print "## 1.2.999\n\nA rehearsal: this build exits when it is started.\n";d=1}1' CHANGELOG.md > c && mv c CHANGELOG.md
printf '\nif(process.argv[1]===fileURLToPath(import.meta.url))setTimeout(()=>{console.error("rehearsal build: exiting");process.exit(1);},300);\n' >> server/index.mjs
git -c user.name=rehearsal -c user.email=rehearsal@example.invalid commit -qam 'rehearsal: exits at start'
git tag v1.2.999 && cd /srv/home-hub && git worktree remove --force /tmp/hub-rehearsal

node scripts/update.mjs apply v1.2.999 --no-fetch --health-seconds 20 --service … --health …
#   → "failed at "starting": health check failed … It was rolled back", exit 1, and the old version answers
node scripts/update.mjs status --service … --health …
git tag -d v1.2.999
```

Delete the tag right away: while it is there, a bare `apply` would take it for the newest release. The note
`quarantined → 1.2.999` stays in `updates.json`; it names a version that will never be released, so nothing shows it. The archive it made counts toward `backups.keep`.

## Limits

- The tests of step 5 run in a fresh worktree. Plugin tests that need files which are not in git (a household's
  data, generated media) fail there; `--skip-tests` skips step 5's test runs (not the `--check`) when you have run
  them where those files are.
- The Node that runs the command is the one whose version is checked and that runs the tests; start the command with
  the Node the service uses.
- A relative `DATA_DIR`, `STATE_DIR` or `AUTH_FILE` is resolved against the directory the command is run in.
- The command does not install or update host agents on other machines (`scripts/install-host-agent.mjs` does, on
  the machine in question).
