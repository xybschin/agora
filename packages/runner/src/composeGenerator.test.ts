import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { generateComposeFile } from "./composeGenerator.js";

// The room id the runner just created is a per-Run value, so it arrives on the
// params rather than being read off the credentials file: every agent container
// has to be told which room this Run is in, and nothing else.

const scenario: ScenarioConfig = {
  name: "remote-work-policy",
  topic: "Should remote work stay optional?",
  seedMessage: "The floor is yours.",
  ticks: 2,
  tickIntervalMs: 60_000,
  maxToolStepsPerTick: 6,
  memory: { windowSize: 20 },
  budget: {},
  agents: ["alex", "bri"].map((id) => ({
    id,
    persona: {
      displayName: id,
      flavorText: "",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0,
    },
  })),
};

const credentials: CredentialsFile = {
  matrixSetupAccessToken: "syt_setup",
  matrixSetupUserId: "@agora-setup:localhost",
  matrix: {
    hostBaseUrl: "http://localhost:8008",
    containerBaseUrl: "http://synapse:8008",
  },
  agents: {
    alex: {
      matrixAccessToken: "syt_alex",
      matrixUserId: "@agora-alex:localhost",
      llmBaseUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "deepseek-v4-flash-sovereign",
    },
    bri: {
      matrixAccessToken: "syt_bri",
      matrixUserId: "@agora-bri:localhost",
      llmBaseUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "deepseek-v4-flash-sovereign",
    },
  },
};

describe("generateComposeFile", () => {
  test("hands every agent the Run's room id in MATRIX_ROOM_ID", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });

    // Parsed rather than string-matched, so this reads as "every agent service
    // is pointed at this Run's room" instead of "the text appears twice".
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    for (const agentId of ["alex", "bri"]) {
      expect(services[`agent_${agentId}`]?.environment["MATRIX_ROOM_ID"]).toBe(
        "!run1:localhost",
      );
    }
    expect(yamlText).not.toContain("!run0:");
  });

  test("still points containers at the container-facing homeserver URL", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });

    // The host-side runner and the containers reach Synapse on different URLs.
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    expect(services["agent_alex"]?.environment["MATRIX_HOME_SERVER_URL"]).toBe(
      "http://synapse:8008",
    );
    expect(services["mcp_server"]?.environment["MATRIX_HOME_SERVER_URL"]).toBe(
      "http://synapse:8008",
    );
    expect(yamlText).not.toContain("http://localhost:8008");
  });

  test("tells the shared MCP server which room this Run is in", () => {
    // One mcp_server serves every agent, and it has to be told the room rather
    // than asking each model for it. The first live Run had two of six agents
    // 403 "not in room" because a model transcribed the id wrong: `!aXphPOUV`
    // against a real `!aXPHpOUV`. Identity is already bound to the session so
    // one agent cannot act as another; the room is bound here for the same
    // reason -- it is a property of the Run, never a choice.
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });

    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;

    expect(services["mcp_server"]?.environment["MATRIX_ROOM_ID"]).toBe(
      "!run1:localhost",
    );
    // And every agent is told the same one, so the two halves cannot disagree.
    for (const [name, svc] of Object.entries(services)) {
      if (!name.startsWith("agent_")) continue;
      expect(svc.environment["MATRIX_ROOM_ID"]).toBe("!run1:localhost");
    }
  });

  test("gives a declared Reader no container, no credentials and no tick", () => {
    // A Reader is a human in the room, not a member of the population: it is
    // deliberately not in the roster, so nothing here can grow a service for it.
    // The whole file coming out byte-identical is the proof -- same services,
    // same env (so no LLM key for a Reader), and the same agentPorts, which is
    // exactly the set the orchestrator ticks.
    const withReaders = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario: { ...scenario, observers: ["@bjarse:localhost"] },
      credentials,
    });

    expect(withReaders.yamlText).toBe(
      generateComposeFile({
        runId: "remote-work-policy-1759000000000",
        roomId: "!run1:localhost",
        scenario,
        credentials,
      }).yamlText,
    );
    expect(withReaders.agentPorts).toEqual({ alex: 4100, bri: 4101 });
    expect(withReaders.yamlText).not.toContain("bjarse");
  });
});
