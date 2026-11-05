# Built from the repository root: docker build -f apps/topup/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/topup ./apps/topup
RUN pnpm install --frozen-lockfile --prod --filter @tredio/topup...

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app ./
COPY deployments ./deployments
ENV NODE_ENV=production PORT=4500
EXPOSE 4500
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4500/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/topup/src/index.ts"]
