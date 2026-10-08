/**
 * Entry point of one agent container: reads the runner-staged env
 * (config.ts), connects to the MCP server as this agent's Matrix account
 * (mcpClient.ts), and runs the agent's event-driven loop (loop.ts) for the
 * life of the process. Each Run starts fresh containers, so one process is one
 * agent in one Run. The Moderator has its own entry point, moderator-index.ts.
 */
import express from "express";
import { createLogger } from "@agora/shared";
import { loadAgentEnvConfig } from "./config.js";
import { MatrixMcpClient } from "./mcpClient.js";
import { AgentRuntime } from "./loop.js";

const env = loadAgentEnvConfig();
const log = createLogger(env.agentId);
const mcp = new MatrixMcpClient(env.mcpUrl, env.matrixAccessToken);

const runtime = new AgentRuntime({
  runId: env.runId,
  agentId: env.agentId,
  agentDef: env.agentDefinition,
  topic: env.topic,
  roomId: env.roomId,
  matrixUserId: env.matrixUserId,
  maxToolStepsPerTick: env.maxToolStepsPerTick,
  logDir: env.logDir,
  mcp,
  llm: env.llm,
  seedMessage: env.seedMessage,
});

// A minimal health endpoint only, so the runner's waitForHealth can probe
// readiness. The agent takes no work over HTTP: it drives itself through
// runtime.runLoop, waking on room activity rather than being called by the
// runner on a schedule (see ADR-0008, agora-xpc.2).
const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true, agentId: env.agentId, stance: runtime.getStance() });
});

app.listen(env.port, "0.0.0.0", () => {
  log.info(`listening on :${env.port} (continuous event-driven loop)`);
});

// Start the event-driven loop. It only settles if it throws: the agent stays
// active for the entire Run, waiting for activity, heartbeating while it waits,
// and taking a turn whenever something new arrives. The runner ends the Run by
// tearing the container down.
runtime.runLoop().catch((err) => {
  // A hard failure of the loop itself (not a failed wait or turn, which runLoop
  // already recovers from) is fatal: exit rather than linger as a healthy-looking
  // container whose agent has gone silent.
  log.error("agent loop exited fatally:", err);
  process.exit(1);
});
