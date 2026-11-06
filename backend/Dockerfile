# Built from the repository root: docker build -f backend/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY backend ./backend
RUN pnpm install --frozen-lockfile --prod --filter @tredio/backend...

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app ./
COPY deployments ./deployments
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4000/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "backend/src/index.ts"]
