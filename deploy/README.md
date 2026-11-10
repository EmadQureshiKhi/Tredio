# Deploying Tredio

The server side (Postgres, the API, the relayer and every service) runs on one machine with Docker Compose, behind Caddy for TLS.
The three sites (app, admin, website) run on Vercel.
Contracts are already on NEAR testnet; their ids come from `deployments/testnet.json`, baked into every image.

## The machine

Any Linux host with Docker and 2 GB of memory or more works; Tredio runs on a Google Cloud e2-medium VM (2 vCPU, 4 GB, Debian 13) with a 2 GB swap file.
`api.tredio.bid` and `relay.tredio.bid` point at it through Cloudflare's proxy, with the SSL mode at Full (strict), and the VM's firewall opens ports 80 and 443 only to [Cloudflare's ranges](https://www.cloudflare.com/ips).
Caddy gets its certificates over HTTP-01 through the proxy and redirects to HTTPS itself, so Cloudflare's "Always Use HTTPS" stays off.
The `Caddyfile` takes the visitor's address from `CF-Connecting-IP` only on requests from those ranges and passes it on as the one `X-Forwarded-For` entry, so the API and relayer run with `TRUSTED_PROXY_HOPS=1`.
Without a proxy in front, point the names straight at the machine and open 80 and 443 to everyone; nothing else changes.

```bash
git clone <this repository> tredio && cd tredio/deploy
mkdir env
```

Create one env file per service in `deploy/env/`, starting from the `.env.example` beside its code, with addresses inside the Compose network:

| File | Start from | Inside the network |
| --- | --- | --- |
| `postgres.env` | `POSTGRES_USER=tredio`, `POSTGRES_PASSWORD=...`, `POSTGRES_DB=tredio` | |
| `backend.env` | `backend/.env.example` | `DATABASE_URL=postgres://tredio:...@postgres:5432/tredio`, `INDEXER_DATABASE_URL=...@postgres:5432/tredio_indexer`, `STATUS_SERVICES=relayer=http://relayer:4100/health,oracle=http://oracle:4600/health,...,indexer=http://indexer:4700/health`, `TRUSTED_PROXY_HOPS=1` |
| `relayer.env` | `apps/relayer/.env.example` | `FRONTEND_URL=https://app.tredio.bid`, `TRUSTED_PROXY_HOPS=1` |
| `keeper.env` | `apps/keeper/.env.example` | `ROTATION_URL=http://backend:4000/v1/rotation` |
| `market-maker.env` | `apps/market-maker/.env.example` | The state file is on the `mm-state` volume (Compose sets `STATE_FILE`); copy an existing `.mm-state.json` into it so resting orders are not stranded |
| `autopilot.env` | `apps/autopilot/.env.example` | `DATABASE_URL=...@postgres:5432/tredio`, `RELAYER_URL=http://relayer:4100` |
| `topup.env` | `apps/topup/.env.example` | |
| `oracle.env` | `apps/oracle/.env.example` | `BACKEND_URL=http://backend:4000` |
| `indexer.env` | `apps/indexer/.env.example` | `DATABASE_URL=...@postgres:5432/tredio_indexer` |

Then:

```bash
docker compose up -d --build
docker compose ps
curl https://api.tredio.bid/v1/status
```

`/v1/status` lists every service's health; each service also answers `/health` and `/live` inside the network.

## The sites

Create three Vercel projects from the repository, with these root directories and environment variables:

| Project | Root directory | Domain | Environment |
| --- | --- | --- | --- |
| App | `frontend` | `app.tredio.bid` | `NEXT_PUBLIC_NEAR_NETWORK=testnet`, `NEXT_PUBLIC_API_URL=https://api.tredio.bid`, `NEXT_PUBLIC_RELAYER_URL=https://relay.tredio.bid`, `NEXT_PUBLIC_APP_URL=https://app.tredio.bid`, `NEXT_PUBLIC_PASSKEY_RP_ID=tredio.bid`, `NEXT_PUBLIC_TREDIO_BOT_ACCOUNT=` the API's `AUTOPILOT_BOT_ACCOUNT` |
| Admin | `admin` | `admin.tredio.bid` | `NEXT_PUBLIC_BACKEND_URL=https://api.tredio.bid`, `NEXT_PUBLIC_NEAR_NETWORK=testnet`, `NEXT_PUBLIC_ADMIN_ACCOUNTS=...` |
| Website | `landing-page` | `tredio.bid` | `NEXT_PUBLIC_APP_URL=https://app.tredio.bid`, `NEXT_PUBLIC_BACKEND_URL=https://api.tredio.bid`, `NEXT_PUBLIC_SITE_URL=https://tredio.bid` |

Each domain is a DNS-only CNAME to the target Vercel shows for it (`vercel domains verify <domain>`), with `www.tredio.bid` redirecting to `tredio.bid`.
Each project's `vercel.json` skips a build when nothing it uses changed.
Keep "Include files outside the root directory" on: the app and admin import `packages/` and `deployments/`.
Deploying with the CLI instead of Git works from the repository root (`VERCEL_PROJECT_ID=... vercel deploy --prod`); `.vercelignore` keeps the upload to what the sites build from, since the CLI does not read `.gitignore`.

## Checking a deployment

```bash
TREDIO_API_URL=https://api.tredio.bid pnpm verify --chain-only
```
