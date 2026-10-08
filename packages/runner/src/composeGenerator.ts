/**
 * Turns a Scenario plus credentials into the docker-compose project for one
 * Run: one container per roster agent, one shared MCP server, and the
 * Moderator. Pure: it returns YAML text and `index.ts` writes it to
 * `runner-generated/docker-compose.<runId>.yml`.
 */
import yaml from "js-yaml";
import type { ScenarioConfig, CredentialsFile, RosterAgent } from "@agora/shared";

export interface ComposeGenerationResult {
  yamlText: string;
  /** agentId -> host port for the runner's health check probe. Agents only; the Moderator has no port. */
  agentPorts: Record<string, number>;
}

/**
 * Generates a docker-compose file per scenario run (Q14). Network isolation
 * (Q8) is implemented by giving each agent its own dedicated bridge network
 * that only it and mcp-server join; agents never share a network with each
 * other, so they cannot reach one another directly -- all interaction must
 * flow through the Matrix MCP server.
 *
 * The mcp_server and Moderator containers additionally join the persistent
 * `agora_infra` network (defined in docker-compose.infra.yml) so they reach
 * the self-hosted Synapse by container DNS name, using
 * `matrix.containerBaseUrl` (e.g. http://synapse:8008) rather than the
 * host-facing `matrix.hostBaseUrl` that the runner itself uses. Agents get
 * neither that network nor a homeserver URL: they reach Matrix only through
 * the MCP server (ADR-0003's Reader invisibility relies on it), so the
 * isolation is structural. Their LLM calls leave through their own bridge
 * network's default egress, which agora_infra was never needed for.
 *
 * Relative paths (`..` build context, `../logs` volume) are resolved by compose
 * against the file's own directory, so they assume the file lives one level
 * below the repo root, where `index.ts` puts it.
 *
 * Throws if a roster agent has no credentials entry.
 */
export function generateComposeFile(params: {
  runId: string;
  /** The room this Run created (ADR-0003); not a credentials-file value. */
  roomId: string;
  scenario: ScenarioConfig;
  credentials: CredentialsFile;
  /** Host port for the first agent; the rest get consecutive ports in roster order. */
  basePort?: number;
}): ComposeGenerationResult {
  const { runId, roomId, scenario, credentials } = params;
  const basePort = params.basePort ?? 4100;

  const agentPorts: Record<string, number> = {};
  const networks: Record<string, { external?: true }> = {};
  const services: Record<string, unknown> = {};
  const mcpNetworks: string[] = [];
  const roster: RosterAgent[] = [];

  // The per-agent isolation networks plus the shared infra network the
  // mcp-server and Moderator containers use to reach Synapse by container DNS.
  networks.agora_infra = { external: true };

  scenario.agents.forEach((agent, index) => {
    const cred = credentials.agents[agent.id];
    if (!cred) throw new Error(`No credentials entry for agent "${agent.id}"`);
    roster.push({ agentId: agent.id, matrixUserId: cred.matrixUserId });

    const netName = `net_${agent.id}`;
    networks[netName] = {};
    mcpNetworks.push(netName);

    const port = basePort + index;
    agentPorts[agent.id] = port;

    // Merge the Run-wide Scenario sampling with this agent's credential
    // override (credential wins field-by-field, so per-agent overrides work
    // while the Scenario's keeps what the credential leaves unset). Omitted
    // when neither source sets anything, so an unchanged Run gets the same
    // (defaults-only) behavior as before.
    const mergedSampling = { ...scenario.samplingParams, ...cred.sampling };
    const hasSampling = Object.keys(mergedSampling).length > 0;

    services[`agent_${agent.id}`] = {
      build: { context: "..", dockerfile: "docker/agent.Dockerfile" },
      networks: [netName],
      ports: [`${port}:4000`],
      volumes: ["../logs:/logs"],
      environment: {
        RUN_ID: runId,
        AGENT_ID: agent.id,
        AGENT_DEFINITION_JSON: JSON.stringify(agent),
        SCENARIO_TOPIC: scenario.topic,
        MATRIX_ROOM_ID: roomId,
        MATRIX_ACCESS_TOKEN: cred.matrixAccessToken,
        MATRIX_USER_ID: cred.matrixUserId,
        // The per-turn tool-step cap, read by the agent's config.ts.
        MAX_TOOL_STEPS_PER_TURN: String(scenario.maxToolStepsPerTurn),
        MCP_URL: "http://mcp_server:3000/mcp",
        LLM_BASE_URL: cred.llmBaseUrl,
        LLM_API_KEY: cred.llmApiKey,
        LLM_MODEL: cred.llmModel,
        ...(hasSampling ? { LLM_SAMPLING_JSON: JSON.stringify(mergedSampling) } : {}),
        // The seed author posted the seed with its own account, so the seed
        // opens its Own message history. Nobody else is told: to them it is
        // another participant's message, read from the room like any other.
        ...(agent.id === scenario.seedAuthor ? { SEED_MESSAGE: scenario.seedMessage } : {}),
        PORT: "4000",
      },
    };
  });

  // mcp_server joins the per-agent isolation networks (so it can field each
  // agent's tool calls in isolation) plus agora_infra so it can reach Synapse
  // by container DNS name. Agent identity is carried by the per-request
  // access token, so the server only needs the homeserver URL, not a
  // dedicated setup token.
  const mcpNetworksWithInfra = [...mcpNetworks, "agora_infra"];

  services.mcp_server = {
    build: { context: "..", dockerfile: "docker/mcp-server.Dockerfile" },
    networks: mcpNetworksWithInfra,
    environment: {
      MATRIX_HOME_SERVER_URL: credentials.matrix.containerBaseUrl,
      // The room is a property of this Run, so the shared server is told which
      // one rather than asking each agent -- and therefore each model -- to
      // supply it. Without this the tools had to take a roomId argument, and
      // the first live Run had two of six agents 403 because a model
      // transcribed the id wrong.
      MATRIX_ROOM_ID: roomId,
    },
  };

  // The Moderator service runs the setup account's continuous assessment loop.
  // It joins every agent network, as mcp_server does, so it can reach the
  // shared MCP server, and writes to the same logs volume.
  services.moderator = {
    build: { context: "..", dockerfile: "docker/moderator.Dockerfile" },
    networks: mcpNetworksWithInfra,
    volumes: ["../logs:/logs"],
    environment: {
      RUN_ID: runId,
      SCENARIO_TOPIC: scenario.topic,
      MATRIX_ROOM_ID: roomId,
      MATRIX_SETUP_USER_ID: credentials.matrixSetupUserId,
      MATRIX_ACCESS_TOKEN: credentials.matrixSetupAccessToken,
      MATRIX_HOME_SERVER_URL: credentials.matrix.containerBaseUrl,
      MCP_URL: "http://mcp_server:3000/mcp",
      // The Scenario's roster, so the Moderator can tell which agents have
      // posted in the room.
      ROSTER_JSON: JSON.stringify(roster),
      // The Moderator's Assessments are LLM calls, but the credentials file has
      // no entry for it, so it borrows the first roster agent's endpoint, key
      // and model. The literal fallbacks only apply to an empty roster.
      LLM_BASE_URL: credentials.agents[scenario.agents[0]?.id || ""]?.llmBaseUrl || "http://localhost",
      LLM_API_KEY: credentials.agents[scenario.agents[0]?.id || ""]?.llmApiKey || "test",
      LLM_MODEL: credentials.agents[scenario.agents[0]?.id || ""]?.llmModel || "test",
      // Only the Run-wide Scenario sampling: the borrowed agent's credential
      // override tunes that agent's voice, not the Moderator's. Unset fields
      // (including temperature) fall to the Moderator's own defaults.
      ...(scenario.samplingParams && Object.keys(scenario.samplingParams).length > 0
        ? { LLM_SAMPLING_JSON: JSON.stringify(scenario.samplingParams) }
        : {}),
      // Explicit, matching the volume mount, rather than the config's fallback.
      LOG_DIR: "/logs",
    },
  };

  // Every environment value is meant literally -- none relies on compose
  // interpolation -- and several carry Scenario free text (topic, persona,
  // seed) that quotes prices like "$600", which compose would otherwise read
  // as a variable and refuse. Escaping all of them in one place means a new
  // free-text value cannot be added without it.
  for (const service of Object.values(services) as { environment: Record<string, string> }[]) {
    service.environment = Object.fromEntries(
      Object.entries(service.environment).map(([key, value]) => [
        key,
        escapeComposeInterpolation(value),
      ]),
    );
  }

  const compose = { services, networks };
  return { yamlText: yaml.dump(compose), agentPorts };
}

/**
 * Doubles every `$` so docker compose passes free text through literally
 * instead of reading `$name` as a variable to interpolate.
 */
function escapeComposeInterpolation(text: string): string {
  return text.replace(/\$/g, () => "$$");
}
