import type { AgentDefinition } from "@agora/shared";

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
  llm: { baseUrl: string; apiKey: string; model: string };
  port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function loadAgentEnvConfig(): AgentEnvConfig {
  const agentDefinition = JSON.parse(requireEnv("AGENT_DEFINITION_JSON")) as AgentDefinition;
  return {
    runId: requireEnv("RUN_ID"),
    agentId: requireEnv("AGENT_ID"),
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
      baseUrl: requireEnv("LLM_BASE_URL"),
      apiKey: requireEnv("LLM_API_KEY"),
      model: requireEnv("LLM_MODEL"),
    },
    port: Number(process.env.PORT ?? 4000),
  };
}
