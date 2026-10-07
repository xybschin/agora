import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadModeratorEnvConfig } from "./moderator-config.js";

// The env the runner's compose file gives the Moderator container.
const MODERATOR_ENV: Record<string, string> = {
  RUN_ID: "remote-work-policy-1759000000000",
  SCENARIO_TOPIC: "Should remote work stay optional?",
  MATRIX_ROOM_ID: "!run1:localhost",
  MATRIX_SETUP_USER_ID: "@agora-setup:localhost",
  MATRIX_ACCESS_TOKEN: "syt_setup",
  MCP_URL: "http://mcp_server:3000/mcp",
  LLM_BASE_URL: "https://example.com/v1",
  LLM_API_KEY: "sk-test",
  LLM_MODEL: "deepseek-v4-flash-sovereign",
};

describe("loadModeratorEnvConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const [name, value] of Object.entries(MODERATOR_ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("reads the Scenario's topic", () => {
    expect(loadModeratorEnvConfig().topic).toBe("Should remote work stay optional?");
  });

  test("fails fast when the topic is missing", () => {
    delete process.env.SCENARIO_TOPIC;
    expect(() => loadModeratorEnvConfig()).toThrow("SCENARIO_TOPIC");
  });
});
