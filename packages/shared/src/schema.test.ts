import { describe, expect, test } from "bun:test";
import {
  parseCredentialsFile,
  parseScenarioConfig,
  matrixReadRoomSchema,
  matrixSendMessageSchema,
  matrixAddReactionSchema,
  matrixToolCatalog,
} from "./schema.js";
import type { z } from "zod";

// The credential shape is owned by shared and must mirror exactly what
// matrixBootstrap.ts writes to credentials.yaml (matrixSetupAccessToken,
// matrixSetupUserId, matrix.hostBaseUrl/containerBaseUrl,
// agents.{id}.matrixAccessToken/matrixUserId + llm fields). This locks in the
// prefactor's target: Matrix-only, and it accepts the bootstrap's output
// unchanged.
//
// There is deliberately no room id in here: every Run creates its own room
// (ADR-0003), so the room is a per-Run value the runner holds rather than
// something the bootstrap provisions once and records.
//
// Likewise there is no Reader in here. A Reader is a human account a Scenario
// names in its `observers` list so they can watch a Run live, and inviting one
// takes nothing but a user id -- so there is nothing for this file to hold, and
// a Reader access token stored here would be a token nobody needs.

const matrixCredentials = {
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
  },
};

describe("parseCredentialsFile", () => {
  test("accepts the Matrix bootstrap output shape", () => {
    const parsed = parseCredentialsFile(matrixCredentials);
    expect(parsed.matrixSetupAccessToken).toBe("syt_setup");
    expect(parsed.matrix.hostBaseUrl).toBe("http://localhost:8008");
    expect(parsed.matrix.containerBaseUrl).toBe("http://synapse:8008");
    expect(parsed.agents["alex"]?.matrixAccessToken).toBe("syt_alex");
    expect(parsed.agents["alex"]?.matrixUserId).toBe("@agora-alex:localhost");
  });

  test("carries no room id, because each Run creates its own room", () => {
    // A stale credentials.yaml written by the old bootstrap still has one; the
    // schema drops it rather than letting a half-reused room back in.
    const parsed = parseCredentialsFile({
      ...matrixCredentials,
      matrixRoomId: "!stale:localhost",
    });
    expect(Object.keys(parsed)).not.toContain("matrixRoomId");
  });

  test("rejects the stale Discord/spacebar credential shape", () => {
    const stale = {
      discordGuildId: "guild",
      discordSetupBotToken: "bot",
      spacebar: { hostBaseUrl: "http://localhost:8008" },
      agents: {
        alex: { discordBotToken: "t", llmApiKey: "k", llmModel: "m", llmBaseUrl: "u" },
      },
    };
    expect(() => parseCredentialsFile(stale)).toThrow();
  });

  test("rejects a credentials file missing the matrix block", () => {
    const missing = {
      matrixSetupAccessToken: "syt_setup",
      matrixSetupUserId: "@u:localhost",
      agents: {},
    };
    expect(() => parseCredentialsFile(missing)).toThrow();
  });

  test("drops a Reader entry, because inviting a Reader needs no token", () => {
    // A Reader is invited by user id alone, so credentials.yaml has no business
    // knowing one exists. Stripping rather than rejecting matches how the stale
    // matrixRoomId is treated: an over-specified file parses down to the shape
    // the runner actually reads.
    const parsed = parseCredentialsFile({
      ...matrixCredentials,
      observers: {
        "@bjarse:localhost": { matrixAccessToken: "syt_reader_should_not_exist" },
      },
    });
    expect(Object.keys(parsed)).not.toContain("observers");
  });

  test("reads a per-agent sampling override off the agent's credential", () => {
    // Per-agent sampling wins over the Scenario's samplingParams; here it is
    // set only for alex, and it must round-trip through the schema.
    const parsed = parseCredentialsFile({
      ...matrixCredentials,
      agents: {
        alex: {
          ...matrixCredentials.agents.alex!,
          sampling: { temperature: 1.4, maxTokens: 400 },
        },
      },
    });
    expect(parsed.agents["alex"]?.sampling).toEqual({ temperature: 1.4, maxTokens: 400 });
  });

  test("rejects a per-agent sampling value out of the API's range", () => {
    expect(() =>
      parseCredentialsFile({
        ...matrixCredentials,
        agents: {
          alex: { ...matrixCredentials.agents.alex!, sampling: { temperature: 2.5 } },
        },
      }),
    ).toThrow();
  });
});

function agent(id: string) {
  return {
    id,
    persona: {
      displayName: id,
      flavorText: "",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0,
    },
  };
}

const scenario = {
  name: "remote-work-policy",
  topic: "Should remote work stay optional?",
  seedMessage: "The floor is yours.",
  ticks: 2,
  memory: { windowSize: 20 },
  budget: {},
  agents: [agent("alex"), agent("bri")],
};

describe("parseScenarioConfig", () => {
  test("reads a Scenario that declares no Readers exactly as before", () => {
    // The point of the optional list: a Scenario that says nothing about
    // Readers parses to the same object it always did, so the Scenario files
    // already in the repo keep behaving identically.
    const parsed = parseScenarioConfig(scenario);
    expect(parsed).toEqual({
      ...scenario,
      tickIntervalMs: 60_000,
      maxToolStepsPerTick: 6,
    });
    expect("observers" in parsed).toBe(false);
  });

  test("reads an observers list as the Run's Readers", () => {
    // `observers` is the Scenario-facing spelling of the glossary's Reader:
    // Matrix user ids the runner invites into this Run's room.
    const parsed = parseScenarioConfig({
      ...scenario,
      observers: ["@bjarse:localhost", "@domain-expert:matrix.example.org:8448"],
    });
    expect(parsed.observers).toEqual([
      "@bjarse:localhost",
      "@domain-expert:matrix.example.org:8448",
    ]);
  });

  test("rejects an observers entry that is not a Matrix user id", () => {
    // Validated only for shape. A user id that is well-formed but wrong (a
    // typo, an unregistered account) has to fail at invite time with the
    // homeserver's own error rather than be guessed at here.
    expect(() =>
      parseScenarioConfig({ ...scenario, observers: ["@bjarse"] }),
    ).toThrow();
    expect(() =>
      parseScenarioConfig({ ...scenario, observers: ["bjarse:localhost"] }),
    ).toThrow();
    expect(() =>
      parseScenarioConfig({ ...scenario, observers: [42] }),
    ).toThrow();
  });

  test("reads samplingParams off a Scenario that sets them", () => {
    // The Run-wide LLM sampling, recorded with every Run of this Scenario.
    const parsed = parseScenarioConfig({
      ...scenario,
      samplingParams: {
        maxTokens: 120,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        temperature: 1.1,
      },
    });
    expect(parsed.samplingParams).toEqual({
      maxTokens: 120,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      temperature: 1.1,
    });
  });

  test("a Scenario that names no samplingParams is unchanged", () => {
    // Optional, like observers: a Scenario that says nothing about sampling
    // must behave exactly as before and get the llm.ts defaults.
    const parsed = parseScenarioConfig(scenario);
    expect("samplingParams" in parsed).toBe(false);
  });

  test("rejects samplingParams values out of the API's range", () => {
    expect(() =>
      parseScenarioConfig({ ...scenario, samplingParams: { temperature: 3 } }),
    ).toThrow();
    expect(() =>
      parseScenarioConfig({ ...scenario, samplingParams: { frequencyPenalty: -1 } }),
    ).toThrow();
    expect(() =>
      parseScenarioConfig({ ...scenario, samplingParams: { maxTokens: 0 } }),
    ).toThrow();
  });

  test("accepts a partial samplingParams set", () => {
    const parsed = parseScenarioConfig({
      ...scenario,
      samplingParams: { maxTokens: 200 },
    });
    expect(parsed.samplingParams).toEqual({ maxTokens: 200 });
  });
});

describe("the Matrix tool schemas", () => {
  // The room is not a tool argument. It is a property of the Run, passed to the
  // MCP server as MATRIX_ROOM_ID, and the first live Run is why: asked to fill
  // in a roomId, deepseek wrote `!aXphPOUV...` for a room called `!aXPHpOUV...`
  // and two of six agents lost their turn to a 403 "not in room" for an account
  // that was joined. These assert the absence, so putting the field back is a
  // failing test rather than a quiet regression.
  const schemas = {
    matrix_read_room: { schema: matrixReadRoomSchema, minimal: {} },
    matrix_send_message: {
      schema: matrixSendMessageSchema,
      minimal: { content: "hello" },
    },
    matrix_add_reaction: {
      schema: matrixAddReactionSchema,
      minimal: { eventId: "$evt", reaction: "👍" },
    },
  };

  for (const [name, { schema, minimal }] of Object.entries(schemas)) {
    test(`${name} takes no room id`, () => {
      const keys = Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
      expect(keys).not.toContain("roomId");
      // A model can never be handed a room to get wrong: the minimum valid call
      // needs no room, and what comes back holds no room.
      const parsed = schema.parse(minimal) as Record<string, unknown>;
      expect(Object.keys(parsed)).not.toContain("roomId");
    });
  }

  test("a model that supplies one anyway has it ignored, not obeyed", () => {
    // Zod strips what a schema does not name, so a model still free to pass a
    // roomId gets a valid call that quietly does not use it. That is the
    // behaviour we want: the argument cannot reach the homeserver.
    const parsed = matrixSendMessageSchema.parse({
      roomId: "!hallucinated:localhost",
      content: "hello",
    });
    expect(parsed).toEqual({ content: "hello" });
  });
});

describe("the Matrix tool catalog", () => {
  // The MCP server registers its tools and the MCP client advertises its tool
  // specs from this one list (agora-ol3), so name, description and schema must
  // not drift between the two sides. Descriptions are prompt text shown to the
  // model verbatim, so a reword here is a behavioral change -- these lock the
  // exact strings in.
  test("covers exactly the three Matrix tools with name, description and schema", () => {
    expect(matrixToolCatalog).toEqual([
      {
        name: "matrix_read_room",
        description: "Read recent messages from the scenario's Matrix room, oldest first.",
        schema: matrixReadRoomSchema,
      },
      {
        name: "matrix_send_message",
        description:
          "Post a message to the room. Set replyToEventId when directly responding to a specific earlier message.",
        schema: matrixSendMessageSchema,
      },
      {
        name: "matrix_add_reaction",
        description:
          "React to a message with an emoji, e.g. as a lightweight agree/disagree signal.",
        schema: matrixAddReactionSchema,
      },
    ]);
  });

  test("every catalog schema serializes to a JSON schema, as the client requires", () => {
    for (const { name, schema } of matrixToolCatalog) {
      const jsonSchema = schema.toJSONSchema();
      expect(jsonSchema.type).toBe("object");
      expect(typeof jsonSchema).toBe("object");
      expect(`${name} tool has a JSON schema`).toBeTruthy();
    }
  });
});
