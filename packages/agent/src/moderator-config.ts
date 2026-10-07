import { resolveSamplingParams, type ResolvedSampling } from "./llm.js";
import type { RosterAgent, SamplingParams } from "@agora/shared";

export interface ModeratorEnvConfig {
  runId: string;
  roomId: string;
  matrixSetupUserId: string;
  matrixAccessToken: string;
  logDir: string;
  mcpUrl: string;
  roster: RosterAgent[];
  llm: { baseUrl: string; apiKey: string; model: string; sampling?: ResolvedSampling };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function readMergedSampling(): SamplingParams | undefined {
  const raw = process.env.LLM_SAMPLING_JSON;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as SamplingParams;
  return parsed;
}

export function loadModeratorEnvConfig(): ModeratorEnvConfig {
  const baseUrl = requireEnv("LLM_BASE_URL");
  const apiKey = requireEnv("LLM_API_KEY");
  const model = requireEnv("LLM_MODEL");
  return {
    runId: requireEnv("RUN_ID"),
    roomId: requireEnv("MATRIX_ROOM_ID"),
    matrixSetupUserId: requireEnv("MATRIX_SETUP_USER_ID"),
    matrixAccessToken: requireEnv("MATRIX_ACCESS_TOKEN"),
    logDir: process.env.LOG_DIR ?? "/logs",
    mcpUrl: requireEnv("MCP_URL"),
    roster: JSON.parse(requireEnv("ROSTER_JSON")) as RosterAgent[],
    llm: {
      baseUrl,
      apiKey,
      model,
      sampling: resolveSamplingParams("moderator", readMergedSampling()),
    },
  };
}
