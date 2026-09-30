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

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, agentId: env.agentId, stance: runtime.getStance() });
});

app.post("/tick", async (req, res) => {
  const tick = Number(req.body?.tick);
  if (!Number.isInteger(tick)) {
    res.status(400).json({ ok: false, error: 'body must include integer "tick"' });
    return;
  }
  // The Run's total tick count (the Scenario's `ticks`), sent per-tick by the
  // runner so the agent can ground "tick N of M". Optional: a request that
  // omits it (e.g. a health probe or a hand-driven tick) degrades to tick == M.
  const totalTicks = Number(req.body?.totalTicks ?? tick);
  try {
    const result = await runtime.runTick(tick, totalTicks);
    res.json({ ok: true, agentId: env.agentId, tick, ...result });
  } catch (err) {
    console.error(`[${env.agentId}] tick ${tick} failed:`, err);
    res.status(500).json({ ok: false, agentId: env.agentId, tick, error: (err as Error).message });
  }
});

app.listen(env.port, "0.0.0.0", () => {
  console.log(`agent ${env.agentId} listening on :${env.port}`);
});
