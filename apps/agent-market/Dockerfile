# Built from the repository root: docker build -f apps/agent-market/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# pnpm applies patches/ (a near-kit fix) while it installs.
COPY patches ./patches
COPY packages ./packages
# The oracle's index method, which the per-source components are computed with.
COPY apps/oracle ./apps/oracle
COPY apps/agent-market ./apps/agent-market
RUN pnpm install --frozen-lockfile --prod --filter @tredio/agent-market...

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app ./
COPY deployments ./deployments
ENV NODE_ENV=production PORT=4800
EXPOSE 4800
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4800/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/agent-market/src/index.ts"]
