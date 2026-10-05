import express from "express";
import { loadAgentEnvConfig } from "./config.js";
import { MatrixMcpClient } from "./mcpClient.js";
import { AgentRuntime } from "./loop.js";

const env = loadAgentEnvConfig();
const mcp = new MatrixMcpClient(env.mcpUrl, env.matrixAccessToken, env.matrixUserId);

const runtime = new AgentRuntime({
  runId: env.runId,
  agentId: env.agentId,
  agentDef: env.agentDefinition,
  topic: env.topic,
  roomId: env.roomId,
  matrixUserId: env.matrixUserId,
  maxToolStepsPerTick: env.maxToolStepsPerTick,
  memoryWindowSize: env.memoryWindowSize,
  logDir: env.logDir,
  mcp,
  llm: env.llm,
});

// A minimal health endpoint only, so the runner's waitForHealth can probe
// readiness. The old per-tick HTTP endpoint (POST /tick, which the runner used
// to call on a fixed schedule) is gone: the agent now runs its own continuous,
// event-driven loop for the life of the process via runtime.runLoop, waking on
// room activity rather than being prompted per tick (see agora-xpc.2).
const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true, agentId: env.agentId, stance: runtime.getStance() });
});

app.listen(env.port, "0.0.0.0", () => {
  console.log(`agent ${env.agentId} listening on :${env.port} (continuous event-driven loop)`);
});

// Start the event-driven loop. This never returns: the agent stays active for
// the entire Run, waiting for activity, heartbeating while it waits, and
// taking a turn whenever something new arrives.
runtime.runLoop().catch((err) => {
  // A hard failure of the loop itself (not a transient wait blip, which runLoop
  // already recovers from) is fatal: the agent's half of the Run would go
  // silent, so exit and let the Run's supervision record the gap.
  console.error(`[${env.agentId}] agent loop exited fatally:`, err);
  process.exit(1);
});
