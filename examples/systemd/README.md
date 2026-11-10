# Scheduled collectors on Linux (systemd)

Home Hub's versions, host-protection and SSH-key pages show snapshots that collectors write into the data
directory. On macOS `scripts/systems/install-launchd.sh` installs the jobs; on Linux use these user units.
They do the same thing at the same intervals.

| Unit | Runs | Every | Writes |
|---|---|---|---|
| `home-hub-systems-collect` | `node scripts/collect-systems.mjs` | 6 h | `data/systems/snapshot.json`, `history.jsonl` |
| `home-hub-systems-upstream` | `node scripts/check-upstream.mjs` | 12 h | `data/systems/upstream.json` |
| `home-hub-security-collect` | `node scripts/collect-security.mjs` | 24 h | `data/security/ssh-keys.json` |

The collectors are read-only: they never install, upgrade or write anything on a machine they probe.

## Before you install them

1. Describe your machines in `local/site.json` and give each one the collector should read an `ssh` entry
   (`docs/plugins.md` → Site configuration). `"alias": "local"` is the machine the collector runs on.
2. Make sure `ssh <alias> true` works from the collector's user without a prompt (`BatchMode=yes` is used).
3. Run each collector once by hand and look at its output:

   ```sh
   node scripts/collect-systems.mjs
   node scripts/check-upstream.mjs
   node scripts/collect-security.mjs
   ```

The probes that exist today read macOS (`"probe": "mac"`) and TrueNAS (`"probe": "nas"`) machines. A Linux
host can run the collectors and read those machines over SSH.

## Install

The units assume the checkout is `~/home-hub` and the server's data directory is `~/home-hub/data`. Edit
`WorkingDirectory=` and `--data` in the three `.service` files if yours differ.

```sh
mkdir -p ~/.config/systemd/user
cp examples/systemd/home-hub-*.service examples/systemd/home-hub-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now home-hub-systems-collect.timer home-hub-systems-upstream.timer
systemctl --user enable --now home-hub-security-collect.timer     # optional: the SSH key inventory
loginctl enable-linger "$USER"                                    # run without an open login session
```

## Check and remove

```sh
systemctl --user list-timers 'home-hub-*'
journalctl --user -u home-hub-systems-collect.service -n 50
systemctl --user start home-hub-systems-collect.service           # run one now

systemctl --user disable --now home-hub-systems-collect.timer home-hub-systems-upstream.timer home-hub-security-collect.timer
rm ~/.config/systemd/user/home-hub-*.service ~/.config/systemd/user/home-hub-*.timer && systemctl --user daemon-reload
```

A page that says "stale" means its timer did not run when it should have: look at `list-timers` and the journal.
