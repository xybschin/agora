/**
 * The zod schemas for everything Agora reads from outside the type system: the
 * Matrix MCP tools' parameters (shared by the MCP server and the agent's MCP
 * client through matrixToolCatalog), Scenario YAML, and credentials.yaml. The
 * TypeScript shapes they validate live in types.ts.
 */
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
// bound to the caller's access token so a model can never act as another Matrix
// user. The
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

// Sending is two tools, not one with an optional reply link: agents given the
// optional link almost never set it, so a message without one could not be read
// as either answering someone or addressing the room (ADR-0010). Choosing the
// tool is choosing between a Reply and a Room post (docs/CONTEXT.md).

export const matrixReplySchema = z.object({
  eventId: z
    .string()
    .describe("Event ID of the message by another participant that this Reply answers"),
  content: z.string().min(1).max(4000),
});

export const matrixPostSchema = z.object({
  content: z.string().min(1).max(4000),
});

export const matrixAddReactionSchema = z.object({
  eventId: z.string(),
  reaction: z.string(),
});

/**
 * The name of the agent-runtime long-poll tool. This tool is part of the shared
 * catalog so the MCP server registers a callable handler for it (the agent loop
 * drives itself through it), but it is a *mechanism* tool rather than a
 * model-facing one: offering a blocking wait to the model would let a turn pin
 * the loop. The agent's MCP client lists it on the server for calling and
 * filters it out of the tool specs advertised to the model. Naming it here
 * keeps the server-registered name and the client-filtered name in lockstep
 * with the catalog entry in matrixToolCatalog below.
 */
export const matrixWaitForActivityTool = "matrix_wait_for_activity";

/**
 * How long the agent's continuous loop blocks on the room long-poll before
 * giving up and resuming. A bounded value keeps a single wait from pinning the
 * agent forever and bounds how stale the loop's view of the room can get if a
 * wake-up is lost. It is both the default and the maximum a caller may request
 * from matrixWaitForActivitySchema, kept at a conventional /sync long-poll
 * length so the homeserver honours it rather than closing the request early.
 */
export const matrixWaitForActivityTimeoutMs = 30_000;

export const matrixWaitForActivitySchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(matrixWaitForActivityTimeoutMs)
    .default(matrixWaitForActivityTimeoutMs)
    .describe("Max milliseconds to block waiting for new room activity before returning"),
  /**
   * The resume token (`next_batch`) from a previous wait, so the next wait
   * starts where the last left off instead of re-reading everything since the
   * agent joined. Omitted on the first wait of a Run.
   */
  since: z.string().optional().describe("Resume token from a previous wait (its nextBatch)"),
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
    name: "matrix_reply",
    description:
      "Send a Reply: answer one specific earlier message by another participant, linked to it so the room shows it as a quoted response. Use this whenever your message agrees with, rebuts or builds on something a specific participant said. eventId is the id of that message; content is your text only, without any quote.",
    schema: matrixReplySchema,
  },
  {
    name: "matrix_post",
    description:
      "Send a Room post: a message to the room as a whole, answering no one in particular -- a new point, a summary, a question to everyone. If you are answering a specific participant, use matrix_reply instead.",
    schema: matrixPostSchema,
  },
  {
    name: "matrix_add_reaction",
    description:
      "React to a message with an emoji, e.g. as a lightweight agree/disagree signal.",
    schema: matrixAddReactionSchema,
  },
  {
    name: matrixWaitForActivityTool,
    description:
      "Block until new messages or reactions arrive in the scenario's Matrix room, or until the timeout elapses. Returns whether anything new arrived and a token (nextBatch) to resume waiting from next time. Intended for the agent runtime's event-driven loop, not for the model.",
    schema: matrixWaitForActivitySchema,
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
export const matrixUserIdSchema = z
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
  // The agent in the roster whose account posts the Seed message. Never the
  // setup account: that is the Moderator, which would then read the seed as its
  // own unanswered question. Membership in the roster is checked below.
  seedAuthor: z.string(),
  maxRuntimeMs: z.number().int().positive(),
  maxToolStepsPerTurn: z.number().int().positive().default(6),
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
}).strict().superRefine((scenario, ctx) => {
  // The seed author has to take part in the discussion: only a roster agent has
  // an account in the Run's room and a view of the seed as its own message.
  if (!scenario.agents.some((agent) => agent.id === scenario.seedAuthor)) {
    ctx.addIssue({
      code: "custom",
      path: ["seedAuthor"],
      message: `seedAuthor "${scenario.seedAuthor}" is not an agent in this Scenario's roster`,
    });
  }
});

/**
 * Validates an already-YAML-parsed Scenario and fills schema defaults (e.g.
 * maxToolStepsPerTurn). Unknown keys are rejected (the schema is strict), and a
 * tick-era Scenario gets a migration message instead of zod's raw error.
 */
export function parseScenarioConfig(raw: unknown) {
  try {
    return scenarioConfigSchema.parse(raw);
  } catch (err) {
    // Provide a helpful error message if this is an old-format Scenario
    // (with ticks/tickIntervalMs instead of maxRuntimeMs).
    if (
      typeof raw === "object" &&
      raw !== null &&
      ("ticks" in raw || "tickIntervalMs" in raw)
    ) {
      throw new Error(
        "This Scenario uses the old tick-based scheduling model (ticks, tickIntervalMs, maxToolStepsPerTick). " +
          "The runner now uses continuous transcript supervision with a wall-clock limit. " +
          "Update the Scenario YAML:\n" +
          "  - Remove: ticks, tickIntervalMs\n" +
          "  - Add: maxRuntimeMs (wall-clock runtime limit in milliseconds)\n" +
          "  - Rename: maxToolStepsPerTick → maxToolStepsPerTurn\n" +
          "For example: maxRuntimeMs: 1200000 (20 minutes).",
      );
    }
    throw err;
  }
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
  // A server-admin account, read only by reclamation to delete rooms through
  // Synapse's admin API (ADR-0009). Optional: without it `--room` refuses and
  // everything else works. Deliberately not the setup account, whose token is
  // handed to the Moderator's container.
  matrixAdmin: z
    .object({
      userId: z.string(),
      accessToken: z.string(),
    })
    .optional(),
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

/**
 * Validates an already-YAML-parsed credentials.yaml. Unlike the Scenario schema
 * this one is not strict: unknown keys (a stale room id, a Reader entry) are
 * stripped rather than rejected, so an over-specified file parses down to the
 * shape the runner reads.
 */
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
