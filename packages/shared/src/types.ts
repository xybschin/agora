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

export interface MemoryConfig {
  /** Max number of recent room messages an agent is told to read per turn. */
  windowSize: number;
}

export interface BudgetConfig {
  maxTotalTokens?: number;
  maxTotalCostUsd?: number;
}

/**
 * Sampling controls applied to an agent's LLM calls (mechanism F: bounded,
 * per-agent-varied output). Optional everywhere; when a field is omitted the
 * next-most-specific source wins, and the final fallback is llm.ts's own
 * defaults (maxTokens ~150, frequency/presence penalties 0.4, temperature
 * hashed from the agent id). Precedence: agent credential > Scenario > defaults.
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
  /** Posted by the runner as a system/moderator message before agents are admitted. */
  seedMessage: string;
  /** Wall-clock runtime limit in milliseconds. The Run ends when this limit is exceeded (wall-clock backstop). */
  maxRuntimeMs: number;
  /** Hard cap on tool-calling steps within a single agent's turn, to bound runaway loops. */
  maxToolStepsPerTurn: number;
  memory: MemoryConfig;
  budget: BudgetConfig;
  agents: AgentDefinition[];
  /**
   * Matrix user ids of this Scenario's Readers: humans invited into each Run's
   * room to watch it live (ADR-0003). Omitted means no Readers, which is not the
   * same as an empty list to any behaviour -- there is simply nobody to invite.
   *
   * A Reader carries no credentials of any kind. It is not in the roster, so it
   * gets no container, no LLM credentials and no tick, and an invite takes only
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
}
