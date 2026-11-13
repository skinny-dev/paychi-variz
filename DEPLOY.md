# Deploying Paychi Variz

The server is one Node.js process with a SQLite database file. It ships as a Docker image
(`Dockerfile`), so the same build runs on Runflare, a VPS, or locally.

**Resources:** 0.5 vCPU, 512 MB RAM, 1 GB persistent disk is plenty to start with.
**Always exactly one instance** — SQLite and the background workers (expiry, webhook retries)
must not run twice. Turn autoscaling off.

## Ports, network, storage

| | Value |
|---|---|
| Container port | `3000` (`PORT`) — HTTP only; HTTPS is terminated by Runflare / your proxy |
| Listen address | `0.0.0.0` (`HOST`) |
| Health check | `GET /healthz` → `{"ok":true}` (also checks the database) |
| Persistent disk | mount at `/app/data` — holds `paychi.db` (+ `-wal`, `-shm`) |
| Stop signal | `SIGTERM`; the server finishes requests and closes the DB within 10 s |
| Docker network | `paychi` (compose) — later services reach this one at `http://variz:3000` |

Outbound traffic: webhooks to merchants' URLs only. Inbound: HTTPS from browsers, merchants'
backends and the listener phones.

## Environment

All variables are listed in [`.env.production.example`](.env.production.example). The ones that
must be set:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (already set in the image) |
| `BASE_URL` | the public `https://…` address, no trailing slash |
| `DB_PATH` | `/app/data/paychi.db` (already set in the image) |
| `BILLING_MODE` | `off` for internal use: no plan needed, no limits (pricing comes later) |
| `SIGNUP_CODE` | invite code needed to sign up; keeps strangers out of a private server |
| `APK_URL` | only if the APK is not inside the image (see below) |
| `TELEGRAM_BOT_TOKEN` | optional: payment alerts in Telegram (bot from @BotFather) |
| `TELEGRAM_API_BASE` | optional: a relay / proxy if the server cannot reach `api.telegram.org` |

On start, the server warns in the logs if `BASE_URL` is not https, or if sign-up is free and open
(no `SIGNUP_CODE`).

## The Android APK

`public/downloads/paychi-listener.apk` is gitignored, so a build from GitHub does not contain it.
Either:

- deploy from your PC with the APK present (CLI deploy uploads the local folder), or
- upload the APK somewhere (e.g. a GitHub release) and set `APK_URL` to its link;
  `/downloads/paychi-listener.apk` then redirects there.

## Runflare

1. Create an app of type **Docker** (not "Node.js": the image pins Node 22, which the built-in
   SQLite needs, and carries the APK).
2. Source: connect the `paychi-variz` GitHub repo (branch `main`), or deploy from this folder with
   Runflare's CLI. Dockerfile path: `Dockerfile` (repo root).
3. Plan: 0.5 vCPU / 512 MB. Instances: **1**, autoscaling off.
4. Port: **3000**.
5. Disk: add a persistent disk (1 GB), mount path **`/app/data`**.
6. Environment: `BASE_URL` = the app's address (Runflare subdomain or your domain), plus anything
   else from `.env.production.example` you want to change.
7. Domain (optional): add your domain in the panel, point its DNS as Runflare shows, enable
   HTTPS, then update `BASE_URL` to it and redeploy.
8. Health check path: `/healthz`.

After the first deploy: open `BASE_URL`, register, and check the logs show no warning you did
not expect. Existing paired phones keep the address they paired with — re-pair them if
`BASE_URL` changes.

## VPS with Docker Compose

```bash
cp .env.production.example .env.production   # set BASE_URL
docker compose up -d --build
```

The container is published on `127.0.0.1:3000`; put Caddy or nginx in front for HTTPS, e.g. Caddy:

```
variz.example.ir {
    reverse_proxy 127.0.0.1:3000
}
```

## Backups

The whole state is the SQLite file. A consistent copy while running:

```bash
docker exec paychi-variz node -e "new (require('node:sqlite').DatabaseSync)('/app/data/paychi.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
```

then download `/app/data/backup.db`. On Runflare, use the disk's backup / snapshot feature if
your plan has one.

## Later: more services

When the web app and the pay relay arrive, give each its own app / container on the `paychi`
network, and move the data to Postgres before running more than one service against it.
