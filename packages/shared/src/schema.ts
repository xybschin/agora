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

/**
 * One tool in the Matrix MCP catalog: the name, the description an agent sees,
 * and the zod schema for its parameters. The name+description+parameters triple
 * is the unit the server registers and the client advertises, so it lives here,
 * once, rather than being hand-written on both sides where it can drift.
 */
export interface MatrixToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
}

/**
 * The MCP tool catalog, shared verbatim between the MCP server
 * (packages/mcp-server) and the MCP client (packages/agent). The server's
 * buildServer registers its tools from this list; the client's listToolSpecs
 * derives its tool spec from it. A tool added, renamed, or reworded here
 * changes both sides in lockstep — the same class of divergence that produced
 * the server/client identity bug (agora-2ja).
 *
 * The descriptions are deliberate, stable prompt text: they are shown verbatim
 * to the agent model, so rewording one changes agent behavior without any
 * behavioral test noticing. Treat them as part of the agent-facing design, not
 * as incidental prose.
 */
export const matrixToolCatalog: MatrixToolDefinition[] = [
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
];

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

/**
 * Per-agent credentials fields that were introduced by a recent change, so a
 * credentials.yaml written before them is otherwise a valid modern file that
 * merely lacks the field. Only these are translated into a readable
 * "missing field" error; any other missing required field means a genuinely
 * different or stale shape and must keep zod's own error.
 */
const RECENTLY_INTRODUCED_REQUIRED_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "matrixUserId",
]);

export function parseCredentialsFile(raw: unknown) {
  try {
    return credentialsFileSchema.parse(raw);
  } catch (err) {
    // A credentials.yaml written before per-agent `matrixUserId` existed is
    // otherwise a valid modern file but carries no `matrixUserId` entry. zod's
    // raw error ("expected string, received undefined" at agents.<id>
    // .matrixUserId) tells the user nothing about what the file is missing or
    // how to fix it. So translate that one missing-per-agent-field case into a
    // single readable error naming the agent and the field.
    //
    // The translation only fires when the missing recently-introduced field is
    // the *entire* problem: the field's key must be genuinely absent from an
    // agent entry (not merely wrong-typed), and the file must parse once that
    // field is filled in for every agent. A file that fails for any other
    // reason too -- a stale Discord-shaped file, a wrong type, a bad value --
    // is a genuinely unexpected validation failure and is surfaced unchanged by
    // rethrowing zod's own error.
    if (err instanceof z.ZodError) {
      const missing = findMissingRecentlyIntroducedField(raw);
      if (missing && parsesWithRecentlyIntroducedFieldsFilled(raw)) {
        throw agentFieldError(missing.agentId, missing.field);
      }
    }
    throw err;
  }
}

interface MissingAgentField {
  agentId: string;
  field: string;
}

/**
 * Find the first agent whose entry is genuinely missing one of the
 * recently-introduced required per-agent fields: the field's key is absent
 * from the raw object (so its value reads as `undefined`), as opposed to being
 * present but malformed. "Missing" is decided against the raw input, not against
 * zod's issues, because zod reports `received: undefined` for both an absent
 * key and a wrong-typed value in this schema. Used to name the agent and field
 * in the readable error; the parsesWithRecentlyIntroducedFieldsFilled guard
 * still keeps the translation to files whose only defect is that missing field.
 */
function findMissingRecentlyIntroducedField(
  raw: unknown,
): MissingAgentField | undefined {
  const agents = agentsRecord(raw);
  if (!agents) {
    return undefined;
  }
  for (const [agentId, entry] of Object.entries(agents)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    for (const field of RECENTLY_INTRODUCED_REQUIRED_AGENT_FIELDS) {
      if (!(field in entry)) {
        return { agentId, field };
      }
    }
  }
  return undefined;
}

/** The `agents` record of a raw credentials file, or undefined if absent. */
function agentsRecord(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const agents = (raw as Record<string, unknown>).agents;
  if (typeof agents !== "object" || agents === null) {
    return undefined;
  }
  return agents as Record<string, unknown>;
}

/**
 * True when `raw` becomes a valid credentials file once every agent entry is
 * given a sentinel value for the recently-introduced required per-agent fields
 * it is missing. This is the guard that keeps the readable translation to
 * files whose *only* defect is a missing recently-introduced field (the
 * "written before it existed" case): a file that still fails to parse after
 * those fields are filled in has other, real problems and must keep zod's own
 * error.
 *
 * The schema types the recently-introduced fields as plain `z.string()`, so
 * any string makes the file parse as far as they are concerned; only the rest
 * of the shape can still fail.
 */
function parsesWithRecentlyIntroducedFieldsFilled(raw: unknown): boolean {
  const agents = agentsRecord(raw);
  if (!agents) {
    return false;
  }
  let copy: unknown;
  try {
    copy = structuredClone(raw);
  } catch {
    return false;
  }
  const copyAgents = agentsRecord(copy);
  if (!copyAgents) {
    return false;
  }
  // Fill only keys that the entry genuinely lacks; a present-but-wrong-typed
  // value stays as-is so a malformed entry still fails the parse below.
  for (const entry of Object.values(copyAgents)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    for (const field of RECENTLY_INTRODUCED_REQUIRED_AGENT_FIELDS) {
      if (!(field in entry)) {
        (entry as Record<string, unknown>)[field] = "";
      }
    }
  }
  return credentialsFileSchema.safeParse(copy).success;
}

function agentFieldError(agentId: string, field: string): Error {
  return new Error(
    [
      `Agent "${agentId}" in the credentials file is missing the required per-agent field "${field}".`,
      `${field} is a per-agent field that is required in the credentials file, added by a recent change; ` +
        `older credentials files written before it existed do not carry it.`,
      `Re-run the credentials bootstrap tool to write a complete entry:`,
      `  bun run packages/runner/src/matrixBootstrap.ts <scenario.yaml> [--out credentials.yaml]`,
    ].join("\n"),
  );
}
