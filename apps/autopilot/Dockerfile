# Built from the repository root: docker build -f apps/autopilot/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# pnpm applies patches/ (a near-kit fix) while it installs.
COPY patches ./patches
COPY packages ./packages
COPY apps/autopilot ./apps/autopilot
RUN pnpm install --frozen-lockfile --prod --filter @tredio/autopilot-executor...

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app ./
COPY deployments ./deployments
ENV NODE_ENV=production PORT=4400
EXPOSE 4400
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4400/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/autopilot/src/index.ts"]
