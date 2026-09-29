import type { AgentDefinition, SamplingParams } from "@agora/shared";
import { resolveSamplingParams, type ResolvedSampling } from "./llm.js";

export interface AgentEnvConfig {
  runId: string;
  agentId: string;
  agentDefinition: AgentDefinition;
  topic: string;
  roomId: string;
  maxToolStepsPerTick: number;
  memoryWindowSize: number;
  logDir: string;
  mcpUrl: string;
  matrixAccessToken: string;
  matrixUserId: string;
  llm: { baseUrl: string; apiKey: string; model: string; sampling?: ResolvedSampling };
  port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Reads the optional merged sampling config the runner staged in
 * LLM_SAMPLING_JSON (Scenario.samplingParams overridden by the agent's own
 * credential sampling) and resolves the final per-agent values -- applying
 * llm.ts defaults, including the agent-id-derived temperature, for anything
 * neither source set. Absent env means the agent gets the defaults.
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
    memoryWindowSize: Number(process.env.MEMORY_WINDOW_SIZE ?? 20),
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
  };
}
