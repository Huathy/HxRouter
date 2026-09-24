# Docker

Run HxRouter in a container. Published images:
- GHCR: [`ghcr.io/huathy/hxrouter`](https://github.com/Huathy/HxRouter/pkgs/container/HxRouter)
- Docker Hub: [`huathy/hxrouter`](https://hub.docker.com/r/huathy/hxrouter) (if published separately)

Multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v 9router-data:/app/data \
  -v hxrouter-data:/migration-data:ro \
  -e DATA_DIR=/app/data \
  --name hxrouter \
  ghcr.io/huathy/hxrouter:latest
```

The `hxrouter-data` mount is read-only compatibility input for pre-v1.0.0 named-volume installs. It is copied automatically into the canonical `9router-data` volume only when that volume has no database. If the old install used `$HOME/.9router:/app/data`, keep using that bind mount or migrate its contents into `9router-data` first.

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f hxrouter        # view logs
docker stop hxrouter           # stop
docker start hxrouter          # start again
docker rm -f hxrouter          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

Production requirements:
- Run one HxRouter process per SQLite file. Multiple containers/processes with separate local volumes do not share proxy-pool fitness state.
- If scaling horizontally, provide a shared database/backend for routing state before enabling multiple app instances.
- Keep the persistent volume name `9router-data` used by `docker-compose.yml`; renaming it creates a new empty database volume.
- Production requires a native SQLite driver. The `sql.js` fallback is single-process development fallback only.

## Optional env vars

Add options to the quick-start command:

```bash
-e PORT=20128 \
-e HOSTNAME=0.0.0.0 \
-e DEBUG=true
```

## Context compression

Context compression runs in the Node process using the bundled `thincontext` dependency. Enable Dashboard → Token Saver → Compress context to compress repeated system and tool context before routing. Failures are diagnosed and the original request is sent unchanged; no sidecar, extra environment variables, or Python dependencies are required.

## Update without manual asset or database steps

`9router-data` is the canonical volume. The compose file also mounts historical `hxrouter-data` read-only for automatic compatibility copying. The entrypoint copies the complete legacy data tree only when `/app/data/db/data.sqlite` does not exist and records `.legacy-volume-migrated`; it never overwrites an existing canonical file. Legacy installs that used a host bind mount (`$HOME/.9router:/app/data`) must keep that bind mount or copy its contents into `9router-data` before switching to named volumes.

```bash
docker compose pull hxrouter
docker compose up -d --no-deps hxrouter
```

For a pinned release, replace `latest` in the compose file with `X.Y.Z` before pulling. Do not copy `.next`, delete either volume, or run application migrations manually. After a successful upgrade, remove the `hxrouter-data:/migration-data:ro` mount only after confirming the new container reports the expected version and data.

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t hxrouter .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  hxrouter
```

## Publish (automatic via CI)

Push an annotated release tag `vX.Y.Z` after the checks in `.agent/cicd.md`. GitHub Actions builds multi-platform (amd64+arm64) and promotes the verified image to:
- `ghcr.io/huathy/hxrouter:X.Y.Z` + `:latest`

Docker Hub is not published by the current workflow; treat its listing as a separate/manual distribution only.

```bash
# Follow .agent/cicd.md; do not tag or publish manually.
git status --short
node cli/scripts/validate-release.cjs vX.Y.Z --pretag
```

Workflow: `.github/workflows/release.yml`
