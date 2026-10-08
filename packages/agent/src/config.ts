/**
 * Reads an agent container's configuration from the environment the runner
 * stages for it (see the runner's composeGenerator). Missing required
 * variables fail fast at startup rather than surfacing mid-Run. The
 * Moderator's container has its own loader, moderator-config.ts.
 */
import type { AgentDefinition, SamplingParams } from "@agora/shared";
import { resolveSamplingParams, type ResolvedSampling } from "./llm.js";

export interface AgentEnvConfig {
  runId: string;
  agentId: string;
  agentDefinition: AgentDefinition;
  topic: string;
  roomId: string;
  /**
   * The per-turn cap on tool-calling rounds: the Scenario's
   * `maxToolStepsPerTurn`. This field and its env var MAX_TOOL_STEPS_PER_TICK
   * still carry their tick-era names.
   */
  maxToolStepsPerTick: number;
  logDir: string;
  mcpUrl: string;
  matrixAccessToken: string;
  matrixUserId: string;
  llm: { baseUrl: string; apiKey: string; model: string; sampling?: ResolvedSampling };
  port: number;
  /** The Scenario's seed, staged by the runner only for the seed author's container. */
  seedMessage?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Parses the optional merged sampling config the runner staged in
 * LLM_SAMPLING_JSON (Scenario.samplingParams overridden by the agent's own
 * credential sampling). Returns undefined when the env is absent; the caller
 * then passes it to resolveSamplingParams, which fills llm.ts defaults --
 * including the agent-id-derived temperature -- for anything neither source
 * set. Malformed JSON throws, failing startup.
 */
function readMergedSampling(): SamplingParams | undefined {
  const raw = process.env.LLM_SAMPLING_JSON;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as SamplingParams;
  return parsed;
}

export function loadAgentEnvConfig(): AgentEnvConfig {
  const agentDefinition = JSON.parse(requireEnv("AGENT_DEFINITION_JSON")) as AgentDefinition;
  const agentId = requireEnv("AGENT_ID");
  const baseUrl = requireEnv("LLM_BASE_URL");
  const apiKey = requireEnv("LLM_API_KEY");
  const model = requireEnv("LLM_MODEL");
  return {
    runId: requireEnv("RUN_ID"),
    agentId,
    agentDefinition,
    topic: requireEnv("SCENARIO_TOPIC"),
    roomId: requireEnv("MATRIX_ROOM_ID"),
    maxToolStepsPerTick: Number(process.env.MAX_TOOL_STEPS_PER_TICK ?? 6),
    logDir: process.env.LOG_DIR ?? "/logs",
    mcpUrl: requireEnv("MCP_URL"),
    matrixAccessToken: requireEnv("MATRIX_ACCESS_TOKEN"),
    matrixUserId: requireEnv("MATRIX_USER_ID"),
    llm: {
      baseUrl,
      apiKey,
      model,
      sampling: resolveSamplingParams(agentId, readMergedSampling()),
    },
    port: Number(process.env.PORT ?? 4000),
    seedMessage: process.env.SEED_MESSAGE || undefined,
  };
}
