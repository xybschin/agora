/**
 * The TypeScript shapes of a Scenario and of the credentials file. schema.ts
 * holds the zod schemas that validate these shapes at load time; the two are
 * maintained by hand and must agree.
 */
export interface PersonaTraits {
  /**
   * 0-1: how far the agent's *public* position may drift from its *private*
   * recorded stance (the one it posts via update_stance) toward apparent group
   * consensus. High conformity means the stated view leans to the room while the
   * private stance stays more guarded; low conformity keeps public ≈ private and
   * resists the pull of the group. Refined by agora-c75.8 to frame the gap as
   * private/public divergence rather than a bare drive toward consensus.
   */
  conformity: number;
  /** 0-1: how forcefully the agent states opinions and pushes back on disagreement. */
  assertiveness: number;
  /** 0-1: how readily the agent updates its private stance given a good argument or evidence. */
  opennessToEvidence: number;
}

export interface Persona {
  displayName: string;
  flavorText: string;
  traits: PersonaTraits;
  /** Seeded starting stance, -1 (fully against) to +1 (fully in favor). */
  initialStance: number;
}

export interface AgentDefinition {
  /** Lowercase-kebab id, also used as the docker-compose service suffix and credentials key. */
  id: string;
  persona: Persona;
}

/**
 * One agent of a Scenario's roster as the Moderator sees it: who the agent is
 * and which Matrix user posts on its behalf, so room messages can be attributed
 * to roster agents.
 */
export interface RosterAgent {
  agentId: string;
  matrixUserId: string;
}

/**
 * Run-wide spending caps. The runner aborts the Run once summed `usage` events
 * exceed `maxTotalTokens`. `maxTotalCostUsd` is accepted by the schema but not
 * enforced anywhere yet.
 */
export interface BudgetConfig {
  maxTotalTokens?: number;
  maxTotalCostUsd?: number;
}

/**
 * Sampling controls applied to an agent's LLM calls (mechanism F: bounded,
 * per-agent-varied output). Optional everywhere; when a field is omitted the
 * next-most-specific source wins, and the final fallback is llm.ts's own
 * defaults (DEFAULT_MAX_TOKENS, DEFAULT_FREQUENCY_PENALTY,
 * DEFAULT_PRESENCE_PENALTY, and a temperature hashed from the agent id by
 * temperatureFromAgentId). Precedence: agent credential > Scenario > defaults.
 */
export interface SamplingParams {
  /** Maximum tokens in the response (enforces brevity). */
  maxTokens?: number;
  /** Penalty for repeating tokens, 0-2 (reduces echo). */
  frequencyPenalty?: number;
  /** Penalty for any occurrence of a token, 0-2 (reduces echo). */
  presencePenalty?: number;
  /** Sampling temperature, 0-2 (per-agent variation avoids convergence). */
  temperature?: number;
}

export interface ScenarioConfig {
  name: string;
  topic: string;
  /** Posted by the runner, with the seed author's account, before any agent acts. */
  seedMessage: string;
  /**
   * Id of the roster agent whose account posts the seed. The Moderator reads it
   * as another participant's message; the author reads it as its own.
   */
  seedAuthor: string;
  /**
   * Wall-clock runtime limit in milliseconds: the backstop for a Run the
   * Moderator never ends. Exceeding it aborts the Run with `run_aborted`.
   */
  maxRuntimeMs: number;
  /** Hard cap on tool-calling steps within a single agent's turn, to bound runaway loops. */
  maxToolStepsPerTurn: number;
  budget: BudgetConfig;
  agents: AgentDefinition[];
  /**
   * Matrix user ids of this Scenario's Readers: humans invited into each Run's
   * room to watch it live (ADR-0003). Omitted behaves exactly like an empty
   * list: there is simply nobody to invite.
   *
   * A Reader carries no credentials of any kind. It is not in the roster, so it
   * gets no container, no LLM credentials and no turns, and an invite takes only
   * a user id -- which is why there is nowhere for a Reader's token to be
   * stored.
   */
  observers?: string[];
  /** Run-wide LLM sampling controls, recorded with the Scenario (every Run is an
   * execution of it). Per-agent credential overrides win over this. */
  samplingParams?: SamplingParams;
}

export interface AgentCredential {
  matrixAccessToken: string;
  matrixUserId: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Per-agent LLM sampling overrides. Wins over the Scenario's samplingParams. */
  sampling?: SamplingParams;
}

export interface MatrixServerConfig {
  /** Base URL the host-side runner uses to reach Matrix, e.g. http://localhost:8008 */
  hostBaseUrl: string;
  /** Base URL containers use to reach Matrix over the shared agora_infra network, e.g. http://synapse:8008 */
  containerBaseUrl: string;
}

export interface CredentialsFile {
  /**
   * Deliberately no room id: a Run creates its own room, so the room belongs to
   * the Run rather than to the credentials file (ADR-0003).
   */
  matrixSetupAccessToken: string;
  matrixSetupUserId: string;
  matrix: MatrixServerConfig;
  agents: Record<string, AgentCredential>;
  /**
   * A server-admin account, read only by reclamation to delete a Run's room
   * through Synapse's admin API (ADR-0009). Never written into a generated
   * compose file, so no container holds it. Absent means `--room` refuses.
   */
  matrixAdmin?: { userId: string; accessToken: string };
}
