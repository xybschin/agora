# Image for the per-Run Matrix MCP server (packages/mcp-server), which every
# agent and the Moderator reach at http://mcp_server:3000/mcp.
#
# Build context is the repo root (see composeGenerator.ts: build.context = "..")
FROM oven/bun:1-slim
WORKDIR /repo

# Manifests first, sources after, so editing source reuses the cached install
# layer. Only shared and mcp-server are copied: the server needs no other
# workspace package.
COPY package.json bun.lock* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN bun install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/mcp-server packages/mcp-server

WORKDIR /repo/packages/mcp-server
# Matches the MCP_URL that composeGenerator.ts hands every agent.
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
