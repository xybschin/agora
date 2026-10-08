# Image for one conversation agent: the runner's composeGenerator.ts gives
# each agent in the Scenario's roster its own container from this image, which
# runs the agent's turn loop (packages/agent/src/index.ts) and reaches Matrix
# only through the mcp_server container. docker/moderator.Dockerfile builds the
# Moderator from the same package.
#
# Build context is the repo root (see composeGenerator.ts: build.context = "..")
FROM oven/bun:1-slim
WORKDIR /repo

COPY package.json bun.lock* ./
COPY packages packages
RUN bun install --frozen-lockfile

WORKDIR /repo/packages/agent
# Matches the agent's default in packages/agent/src/config.ts.
ENV PORT=4000
EXPOSE 4000
CMD ["bun", "run", "src/index.ts"]
