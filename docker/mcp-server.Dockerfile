# Build context is the repo root (see composeGenerator.ts: build.context = "..")
FROM oven/bun:1-slim
WORKDIR /repo

COPY package.json bun.lock* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN bun install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/mcp-server packages/mcp-server

WORKDIR /repo/packages/mcp-server
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
