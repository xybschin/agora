import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { generateComposeFile } from "./composeGenerator.js";

// Pins the environment each generated service receives: the Run's room id and
// container-facing homeserver URL, sampling and seed handed only where they
// belong, the Moderator's topic and roster, and compose-safe escaping of every
// value. The room id is a per-Run value, so it arrives on the params rather than
// being read off the credentials file.

const scenario: ScenarioConfig = {
  name: "remote-work-policy",
  topic: "Should remote work stay optional?",
  seedMessage: "The floor is yours.",
  seedAuthor: "alex",
  maxRuntimeMs: 120000,
  maxToolStepsPerTurn: 6,
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

  test("passes the per-turn tool-step cap under the name the agent config reads", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    // packages/agent/src/config.ts reads MAX_TOOL_STEPS_PER_TURN.
    expect(services["agent_alex"]?.environment["MAX_TOOL_STEPS_PER_TURN"]).toBe(
      String(scenario.maxToolStepsPerTurn),
    );
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

  test("hands the Moderator the Scenario's topic, as agents get it", () => {
    // The Moderator judges whether new arguments are on-topic and substantive,
    // which it cannot do without knowing what the topic is.
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });

    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;

    expect(services["moderator"]?.environment["SCENARIO_TOPIC"]).toBe(scenario.topic);
  });

  test("gives a declared Reader no container, no credentials and no turns", () => {
    // A Reader is a human in the room, not a member of the population: it is
    // deliberately not in the roster, so nothing here can grow a service for it.
    // The whole file coming out byte-identical is the proof -- same services,
    // same env (so no LLM key for a Reader), and the same agentPorts, which is
    // exactly the set the runner health-checks.
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

  test("passes the Scenario's samplingParams to each agent as LLM_SAMPLING_JSON", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario: {
        ...scenario,
        samplingParams: { maxTokens: 120, frequencyPenalty: 0.5, temperature: 1.1 },
      },
      credentials,
    });

    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;

    for (const agentId of ["alex", "bri"]) {
      // The agent resolves the final values (defaults + agent-id temperature);
      // the runner only forwards the merged Scenario-wide sampling.
      const merged = JSON.parse(
        services[`agent_${agentId}`]!.environment["LLM_SAMPLING_JSON"]!,
      ) as {
        maxTokens?: number;
        frequencyPenalty?: number;
        temperature?: number;
      };
      expect(merged.maxTokens).toBe(120);
      expect(merged.frequencyPenalty).toBe(0.5);
      expect(merged.temperature).toBe(1.1);
    }
  });

  test("a per-agent credential sampling override wins field-by-field", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario: {
        ...scenario,
        samplingParams: { maxTokens: 120, temperature: 1.1 },
      },
      credentials: {
        ...credentials,
        agents: {
          ...credentials.agents,
          alex: { ...credentials.agents.alex!, sampling: { maxTokens: 400, temperature: 1.4 } },
        },
      },
    });

    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;

    // alex's credential override wins where it is set...
    expect(JSON.parse(services["agent_alex"]!.environment["LLM_SAMPLING_JSON"]!)).toEqual({
      maxTokens: 400,
      temperature: 1.4,
    });
    // ...while bri, which has no override, keeps the Scenario's values.
    expect(JSON.parse(services["agent_bri"]!.environment["LLM_SAMPLING_JSON"]!)).toEqual({
      maxTokens: 120,
      temperature: 1.1,
    });
  });

  test("gives the Moderator the roster: every agent id with its Matrix user", () => {
    // The Moderator attributes room messages to roster agents by Matrix user,
    // e.g. to refuse a STALE Assessment while an agent has not spoken yet.
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });

    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    expect(JSON.parse(services["moderator"]!.environment["ROSTER_JSON"]!)).toEqual([
      { agentId: "alex", matrixUserId: "@agora-alex:localhost" },
      { agentId: "bri", matrixUserId: "@agora-bri:localhost" },
    ]);
  });

  test("emits no LLM_SAMPLING_JSON when neither source sets sampling", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });
    expect(yamlText).not.toContain("LLM_SAMPLING_JSON");
  });

  // The seed is posted with the seed author's account, so it is that agent's own
  // message: only its container is told the text, to start its Own message
  // history with it. Every other agent reads the seed as someone else's.
  test("hands the seed only to the seed author, as SEED_MESSAGE", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario,
      credentials,
    });
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    expect(services["agent_alex"]?.environment["SEED_MESSAGE"]).toBe(
      "The floor is yours.",
    );
    expect(services["agent_bri"]?.environment).not.toHaveProperty("SEED_MESSAGE");
  });

  test("escapes a seed's dollar signs so compose does not interpolate them", () => {
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario: { ...scenario, seedMessage: "She needs $600, not $HOME." },
      credentials,
    });
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    expect(services["agent_alex"]?.environment["SEED_MESSAGE"]).toBe(
      "She needs $$600, not $$HOME.",
    );
  });

  // docker compose interpolates `$name` and `${...}` in every environment value,
  // and refuses `$600` outright. Scenario free text reaches the containers in
  // more places than the seed, so every value is escaped; decoding `$$` the way
  // compose does must give back the original text.
  test("escapes dollar signs in every env value so compose hands back the original text", () => {
    const topic = "Is $600 rent fair when ${HOME} costs more?";
    const flavorText = "Pays $600 a month; quotes ${HOME} and $USER.";
    const { yamlText } = generateComposeFile({
      runId: "remote-work-policy-1759000000000",
      roomId: "!run1:localhost",
      scenario: {
        ...scenario,
        topic,
        agents: scenario.agents.map((a) => ({
          ...a,
          persona: { ...a.persona, flavorText },
        })),
      },
      credentials,
    });
    const services = (yaml.load(yamlText) as {
      services: Record<string, { environment: Record<string, string> }>;
    }).services;
    const decode = (v: string | undefined) => v?.replace(/\$\$/g, "$");

    for (const [name, svc] of Object.entries(services)) {
      for (const [key, value] of Object.entries(svc.environment)) {
        // Every `$` left in the file must be an escaped pair, or compose would
        // read it as the start of a variable.
        expect({ name, key, value: value.replace(/\$\$/g, "") }).toEqual({
          name,
          key,
          value: expect.not.stringContaining("$"),
        });
      }
    }
    for (const agentId of ["alex", "bri"]) {
      const env = services[`agent_${agentId}`]!.environment;
      expect(decode(env["SCENARIO_TOPIC"])).toBe(topic);
      expect(
        JSON.parse(decode(env["AGENT_DEFINITION_JSON"])!).persona.flavorText,
      ).toBe(flavorText);
    }
    expect(decode(services["moderator"]!.environment["SCENARIO_TOPIC"])).toBe(topic);
  });
});
