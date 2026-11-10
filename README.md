# Home Hub

One page for a home network: the machines and how they are doing, what runs where and what depends on what,
who may reach it, and a small tracker for your own projects. One Node process, no third-party dependencies,
a plain-JavaScript front end, and an MCP endpoint so agents can read and maintain the same data.

This is the public core. It knows no particular household: you describe yours in `local/site.json` and add
your own features as plugins under `local/plugins/`.

## Start

Node 22 or newer. There is nothing to install.

```sh
node scripts/provision-secrets.mjs      # creates private/auth.json and prints nothing secret
LOCAL_PREVIEW=1 PORT=8799 node server/index.mjs
```

Open http://127.0.0.1:8799 and sign in as `admin` with the password in `private/ACCESS.txt`. An empty hub tells
you what to add where. To serve it on your network, put it behind a reverse proxy with TLS and set
`ORIGIN=https://hub.example.lan` (or `publicOrigin` in `local/site.json`) instead of `LOCAL_PREVIEW=1`.

## Make it yours

```sh
mkdir -p local && cp config/site.example.json local/site.json
```

Edit the name, your network, and your machines, then restart. `docs/plugins.md` explains every field, how the
collectors use it, and how to write a plugin.

| Read | For |
|---|---|
| `docs/plugins.md` | Site configuration, the plugin contract, the public export |
| `docs/API.md` | The HTTP API |
| `docs/review.md`, `docs/storage.md` | Review sets and uploads; where state lives |
| `SPEC.md`, `AGENTS.md` | What it is and the rules for changing it |

## Optional companions

- **Thermo** (a macOS menu-bar app) feeds live CPU, GPU, power, temperature and memory to the overview. Without
  it the tiles show the static facts from your configuration.
- **A UniFi gateway** feeds the client census (`scripts/collect-router-unifi.py`).

## Checks

```sh
npm test
```

Exported from commit `b7eff64` of the private repository. History is not included.
