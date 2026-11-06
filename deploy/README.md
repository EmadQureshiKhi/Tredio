# Deploying Tredio

The server side (Postgres, the API, the relayer and every service) runs on one machine with Docker Compose, behind Caddy for TLS.
The three sites (app, admin, website) run on Vercel.
Contracts are already on NEAR testnet; their ids come from `deployments/testnet.json`, baked into every image.

## The machine

Any Linux host with Docker and 2 GB of memory or more works; Tredio runs on an Ampere A1 VM (ARM, 2 OCPU, 12 GB).
Open ports 80 and 443, and point `api.tredio.bid` and `relay.tredio.bid` at it (DNS only, no proxy, so Caddy can get certificates).

```bash
git clone <this repository> tredio && cd tredio/deploy
mkdir env
```

Create one env file per service in `deploy/env/`, starting from the `.env.example` beside its code, with addresses inside the Compose network:

| File | Start from | Inside the network |
| --- | --- | --- |
| `postgres.env` | `POSTGRES_USER=tredio`, `POSTGRES_PASSWORD=...`, `POSTGRES_DB=tredio` | |
| `backend.env` | `backend/.env.example` | `DATABASE_URL=postgres://tredio:...@postgres:5432/tredio`, `INDEXER_DATABASE_URL=...@postgres:5432/tredio_indexer`, `STATUS_SERVICES=relayer=http://relayer:4100/health,oracle=http://oracle:4600/health,...` |
| `relayer.env` | `apps/relayer/.env.example` | `FRONTEND_URL=https://app.tredio.bid` |
| `keeper.env` | `apps/keeper/.env.example` | `ROTATION_URL=http://backend:4000/v1/rotation` |
| `market-maker.env` | `apps/market-maker/.env.example` | |
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
| App | `frontend` | `app.tredio.bid` | `NEXT_PUBLIC_NEAR_NETWORK=testnet`, `NEXT_PUBLIC_API_URL=https://api.tredio.bid`, `NEXT_PUBLIC_RELAYER_URL=https://relay.tredio.bid`, `NEXT_PUBLIC_APP_URL=https://app.tredio.bid`, `NEXT_PUBLIC_PASSKEY_RP_ID=tredio.bid` |
| Admin | `admin` | `admin.tredio.bid` | `NEXT_PUBLIC_BACKEND_URL=https://api.tredio.bid`, `NEXT_PUBLIC_NEAR_NETWORK=testnet`, `NEXT_PUBLIC_ADMIN_ACCOUNTS=...` |
| Website | `landing-page` | `tredio.bid` | `NEXT_PUBLIC_APP_URL=https://app.tredio.bid`, `NEXT_PUBLIC_BACKEND_URL=https://api.tredio.bid`, `NEXT_PUBLIC_SITE_URL=https://tredio.bid` |

Each project's `vercel.json` skips a build when nothing it uses changed.
Keep "Include files outside the root directory" on: the app and admin import `packages/` and `deployments/`.

## Checking a deployment

```bash
TREDIO_API_URL=https://api.tredio.bid pnpm verify --chain-only
```
