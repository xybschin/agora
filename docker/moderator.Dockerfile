# Build context is the repo root (see composeGenerator.ts: build.context = "..")
FROM oven/bun:1-slim
WORKDIR /repo

COPY package.json bun.lock* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN bun install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/agent packages/agent

WORKDIR /repo/packages/agent
CMD ["bun", "run", "src/moderator-index.ts"]
