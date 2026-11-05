# Built from the repository root: docker build -f apps/relayer/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/relayer ./apps/relayer
RUN pnpm install --frozen-lockfile --prod --filter @tredio/relayer...

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app ./
COPY deployments ./deployments
ENV NODE_ENV=production PORT=4100
EXPOSE 4100
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4100/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/relayer/src/index.ts"]
