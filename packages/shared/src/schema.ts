import { z } from "zod";

// The room is not a tool parameter. It is a property of the Run, fixed when the
// runner creates the room and handed to the MCP server as MATRIX_ROOM_ID, and
// it was left out of these schemas on purpose.
//
// The first live Run failed because of it: an agent asked to post was handed a
// `roomId` field to fill in, and deepseek transcribed it as `!aXphPOUV...`
// against a real room called `!aXPHpOU...`. Synapse answered 403 "not in room"
// for a user who was, in fact, joined. Two of six agents lost a turn to a
// hallucinated identifier.
//
// This is the same mistake the design already avoided for identity: identity is
// bound to the session so a model can never act as another Matrix user. The
// room belongs in the environment for the same reason and with the same force --
// it is never a choice, so it should never be a question.

export const matrixReadRoomSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max number of recent events/messages to return"),
});

export const matrixSendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  replyToEventId: z
    .string()
    .optional()
    .describe("Event ID to reply to, if directly responding to someone"),
});

export const matrixAddReactionSchema = z.object({
  eventId: z.string(),
  reaction: z.string(),
});

const personaSchema = z.object({
  displayName: z.string(),
  flavorText: z.string(),
  traits: z.object({
    conformity: z.number().min(0).max(1),
    assertiveness: z.number().min(0).max(1),
    opennessToEvidence: z.number().min(0).max(1),
  }),
  initialStance: z.number().min(-1).max(1),
});

const agentDefinitionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, "agent id must be lowercase-kebab (a-z, 0-9, -)"),
  persona: personaSchema,
});

/**
 * A Matrix user id, validated only for shape: `@localpart:server` (with an
 * optional `:port` on the server, e.g. `@bjarse:example.org:8448`).
 *
 * Deliberately loose beyond that. A well-formed id naming an account that does
 * not exist has to fail at invite time with the homeserver's own error, which
 * is more useful than a guess made here about what the author meant.
 */
const matrixUserIdSchema = z
  .string()
  .regex(/^@[^:\s]+:\S+$/, "Matrix user id must look like @localpart:server");

/**
 * LLM sampling controls, optional in both the Scenario and a per-agent
 * credential. Values are clamped to the ranges the (OpenAI-compatible) API
 * accepts; anything out of range is a config error rather than silently
 * passed through. Absent means "use the next source / the llm.ts default".
 */
const samplingParamsSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().min(0).max(2).optional(),
  presencePenalty: z.number().min(0).max(2).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const scenarioConfigSchema = z.object({
  name: z.string(),
  topic: z.string(),
  seedMessage: z.string(),
  ticks: z.number().int().positive(),
  tickIntervalMs: z.number().int().positive().default(60_000),
  maxToolStepsPerTick: z.number().int().positive().default(6),
  memory: z.object({
    windowSize: z.number().int().positive().default(20),
  }),
  budget: z.object({
    maxTotalTokens: z.number().int().positive().optional(),
    maxTotalCostUsd: z.number().positive().optional(),
  }),
  agents: z.array(agentDefinitionSchema).min(2),
  // The Scenario's Readers: human accounts the runner invites into this Run's
  // room so they can watch it live. Optional because most Scenarios name none,
  // and a Scenario that says nothing about Readers must behave exactly as it did
  // before the list existed -- no invite, and a room whose permissions are
  // pinned to the same levels either way.
  observers: z
    .array(matrixUserIdSchema)
    .optional()
    .describe("Matrix user ids of Readers to invite into this Run's room"),
  // Whole-Scenario LLM sampling, recorded with the Run (every Run carries the
  // Scenario that produced it). Optional: a Scenario that says nothing about
  // sampling must behave exactly as before and get the llm.ts defaults.
  samplingParams: samplingParamsSchema.optional(),
});

export function parseScenarioConfig(raw: unknown) {
  return scenarioConfigSchema.parse(raw);
}

const agentCredentialSchema = z.object({
  matrixAccessToken: z.string(),
  matrixUserId: z.string(),
  llmBaseUrl: z.string(),
  llmApiKey: z.string(),
  llmModel: z.string(),
  // Per-agent sampling overrides; wins over the Scenario's samplingParams.
  sampling: samplingParamsSchema.optional(),
});

const matrixConfigSchema = z.object({
  hostBaseUrl: z.string(),
  containerBaseUrl: z.string(),
});

export const credentialsFileSchema = z.object({
  // No room id: each Run creates its own room (ADR-0003), so the room is a
  // per-Run value the runner holds rather than something provisioned once at
  // bootstrap time and reused by every Run of the Scenario.
  matrixSetupAccessToken: z.string(),
  matrixSetupUserId: z.string(),
  matrix: matrixConfigSchema,
  agents: z.record(z.string(), agentCredentialSchema),
});

export function parseCredentialsFile(raw: unknown) {
  return credentialsFileSchema.parse(raw);
}
