# Tredio indexer. Build from the repo root: docker build -f apps/indexer/Dockerfile .
FROM oven/bun:1.4.2-alpine

WORKDIR /app/apps/indexer
COPY apps/indexer/package.json ./
RUN bun install --production --no-save

COPY apps/indexer/tsconfig.json ./
COPY apps/indexer/src ./src
# The contract addresses and start block come from the deployments file at the repo root.
COPY deployments /app/deployments

ENV NODE_ENV=production PORT=4600
USER bun
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- "http://127.0.0.1:${PORT}/live" >/dev/null || exit 1
CMD ["bun", "src/index.ts"]
