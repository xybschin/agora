import yaml from "js-yaml";
import type { ScenarioConfig, CredentialsFile, RosterAgent } from "@agora/shared";

export interface ComposeGenerationResult {
  yamlText: string;
  /** agentId -> host port for the runner's health check probe. */
  agentPorts: Record<string, number>;
}

/**
 * Generates a docker-compose file per scenario run (Q14). Network isolation
 * (Q8) is implemented by giving each agent its own dedicated bridge network
 * that only it and mcp-server join; agents never share a network with each
 * other, so they cannot reach one another directly -- all interaction must
 * flow through the Matrix MCP server.
 *
 * The agent and mcp_server containers additionally join the persistent
 * `agora_infra` network (defined in docker-compose.infra.yml) so they reach
 * the self-hosted Synapse by container DNS name, using
 * `matrix.containerBaseUrl` (e.g. http://synapse:8008) rather than the
 * host-facing `matrix.hostBaseUrl` that the runner itself uses.
 */
export function generateComposeFile(params: {
  runId: string;
  /** The room this Run created (ADR-0003); not a credentials-file value. */
  roomId: string;
  scenario: ScenarioConfig;
  credentials: CredentialsFile;
  basePort?: number;
}): ComposeGenerationResult {
  const { runId, roomId, scenario, credentials } = params;
  const basePort = params.basePort ?? 4100;

  const agentPorts: Record<string, number> = {};
  const networks: Record<string, { external?: true }> = {};
  const services: Record<string, unknown> = {};
  const mcpNetworks: string[] = [];
  const roster: RosterAgent[] = [];

  // The per-agent isolation networks plus the shared infra network the agent
  // and mcp-server containers use to reach Synapse by container DNS.
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
      networks: [netName, "agora_infra"],
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
        // Containers reach the self-hosted Synapse over the shared infra
        // network, so they use the container-facing base URL, not the host one.
        MATRIX_HOME_SERVER_URL: credentials.matrix.containerBaseUrl,
        MAX_TOOL_STEPS_PER_TICK: String(scenario.maxToolStepsPerTurn),
        MCP_URL: "http://mcp_server:3000/mcp",
        LLM_BASE_URL: cred.llmBaseUrl,
        LLM_API_KEY: cred.llmApiKey,
        LLM_MODEL: cred.llmModel,
        ...(hasSampling ? { LLM_SAMPLING_JSON: JSON.stringify(mergedSampling) } : {}),
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
  // It shares the MCP server with agents and inherits the room id via environment.
  services.moderator = {
    build: { context: "..", dockerfile: "docker/moderator.Dockerfile" },
    networks: mcpNetworksWithInfra,
    volumes: ["../logs:/logs"],
    environment: {
      RUN_ID: runId,
      MATRIX_ROOM_ID: roomId,
      MATRIX_SETUP_USER_ID: credentials.matrixSetupUserId,
      MATRIX_ACCESS_TOKEN: credentials.matrixSetupAccessToken,
      MATRIX_HOME_SERVER_URL: credentials.matrix.containerBaseUrl,
      MCP_URL: "http://mcp_server:3000/mcp",
      // The Scenario's roster, so the Moderator can tell which agents have
      // posted in the room.
      ROSTER_JSON: JSON.stringify(roster),
      LLM_BASE_URL: credentials.agents[scenario.agents[0]?.id || ""]?.llmBaseUrl || "http://localhost",
      LLM_API_KEY: credentials.agents[scenario.agents[0]?.id || ""]?.llmApiKey || "test",
      LLM_MODEL: credentials.agents[scenario.agents[0]?.id || ""]?.llmModel || "test",
    },
  };

  const compose = { services, networks };
  return { yamlText: yaml.dump(compose), agentPorts };
}
