/**
 * Reads the Moderator container's configuration from the environment the
 * runner's compose file (packages/runner/src/composeGenerator.ts) sets for the
 * `moderator` service. The agent-side counterpart is config.ts. Missing
 * required vars throw at startup, so a misconfigured Moderator fails fast
 * instead of silently never ending the Run.
 */
import { resolveSamplingParams, type ResolvedSampling } from "./llm.js";
import type { RosterAgent, SamplingParams } from "@agora/shared";

export interface ModeratorEnvConfig {
  runId: string;
  /** The Scenario's topic (`SCENARIO_TOPIC`). */
  topic: string;
  roomId: string;
  matrixSetupUserId: string;
  /** The setup account's token: the Moderator acts as the setup account. */
  matrixAccessToken: string;
  logDir: string;
  mcpUrl: string;
  /** The Scenario's agents with their Matrix users, parsed from `ROSTER_JSON`. */
  roster: RosterAgent[];
  llm: { baseUrl: string; apiKey: string; model: string; sampling?: ResolvedSampling };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Optional sampling overrides from `LLM_SAMPLING_JSON`: the Scenario's
 * Run-wide `samplingParams` only (no credential override, see the runner's
 * composeGenerator). Throws on malformed JSON.
 */
function readMergedSampling(): SamplingParams | undefined {
  const raw = process.env.LLM_SAMPLING_JSON;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as SamplingParams;
  return parsed;
}

/**
 * Builds the Moderator's config from `process.env`. Throws naming the first
 * missing required var, or on malformed `ROSTER_JSON`/`LLM_SAMPLING_JSON`.
 * `LOG_DIR` defaults to /logs, the container's mount of the Run logs.
 */
export function loadModeratorEnvConfig(): ModeratorEnvConfig {
  const baseUrl = requireEnv("LLM_BASE_URL");
  const apiKey = requireEnv("LLM_API_KEY");
  const model = requireEnv("LLM_MODEL");
  return {
    runId: requireEnv("RUN_ID"),
    topic: requireEnv("SCENARIO_TOPIC"),
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
      // Resolved under the id "moderator": without overrides the temperature
      // comes from temperatureFromAgentId("moderator"), like any agent's.
      sampling: resolveSamplingParams("moderator", readMergedSampling()),
    },
  };
}
