# Build context is the repo root (see composeGenerator.ts: build.context = "..")
FROM oven/bun:1-slim
WORKDIR /repo

COPY package.json bun.lock* ./
COPY packages packages
RUN bun install --frozen-lockfile

WORKDIR /repo/packages/agent
ENV PORT=4000
EXPOSE 4000
CMD ["bun", "run", "src/index.ts"]
