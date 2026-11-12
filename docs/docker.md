# Docker

The short version is in the [README](../README.md#docker). This is all of it.

Build it yourself from this checkout; no registry image, CI or npm install is involved. The
[Dockerfile](../Dockerfile) pins `node:22.23.5-alpine3.24`, includes Git, OpenSSH client tools, rsync and Python
for optional collectors, and runs the server as the image's `node` user (UID/GID 1000).

```sh
# Set this to the HTTPS address served by your reverse proxy.
export ORIGIN=https://hub.example.lan
docker compose up -d --build
docker compose exec hub node scripts/setup.mjs
```

Open your HTTPS address and sign in. Until the setup command creates the owner, the hub shows instructions
for finishing setup. There is no default password. Compose publishes HTTP on **127.0.0.1:8781** of the Docker
host: point a TLS reverse proxy there. `ORIGIN` must exactly match the browser's HTTPS origin, including a
non-default port. Secure sign-in cookies require HTTPS; this Compose setup is for a proxy, not an HTTP preview.
If the proxy is another container, attach it to the Compose network and use `hub:8781` as its upstream.

The container listens on `0.0.0.0:8781`, uses `HTTP_BEHIND_PROXY=1`, and checks `/healthz` with Node (no curl
needed). Named volumes keep `/app/data`, `/app/private` and `/app/state`; `STATE_DIR=/app/state` deliberately
separates application state from collector output. Back up **all three volumes**, with the hub stopped for a
consistent SQLite copy. `docker compose down` preserves them; `down -v` deletes them.

The image excludes `local/`, git history, credentials and runtime files. To supply a site and plugins, create
`local/` on the host and add this mount to the `hub` service in a Compose override:

```yaml
services:
  hub:
    volumes:
      - ./local:/app/local:ro
```

A read-only overlay supports configuration, images and plugins. To edit the software watch list through the
API, make that overlay writable by UID 1000; that list lives in `local/software-watch.json`. Bind-mounted
state directories must also be writable by UID 1000 (named volumes are initialized with the correct owner).
Never bake your overlay or credentials into a distributable image.

Optional collectors need network and SSH access from the container. A loopback runtime address means the
container itself; use an address reachable from it. Collectors that need macOS tools should run on a Mac and
publish their snapshots into the data volume. Rebuild and restart to update:

```sh
git pull --ff-only
docker compose up -d --build
```
