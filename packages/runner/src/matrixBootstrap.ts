#!/usr/bin/env node
/**
 * Provisions the Matrix accounts a scenario needs against a self-hosted
 * homeserver (e.g., Synapse, Dendrite): registers one account per agent plus
 * one "setup" account, and writes the result to credentials.yaml.
 *
 * It deliberately creates no room. A Run creates its own room (ADR-0003), so the
 * room id is a per-Run value the runner holds rather than something this script
 * provisions once and every Run of the Scenario reuses. The setup account is
 * still registered here because the runner needs its token to create each
 * room and admit the agents, and because it becomes the Moderator in every
 * Run's room (ADR-0008). It is registered as "Setup"; the runner renames it to
 * "Moderator" when it joins a Run's room. (The seed message is posted by the
 * Scenario's `seedAuthor`, not by the setup account.)
 *
 * Every invocation registers fresh accounts and rewrites the output file. Only
 * each agent's LLM settings and `matrix.containerBaseUrl` are carried over from
 * an existing file, so previously issued Matrix tokens are replaced, not reused.
 *
 * If your homeserver requires registration tokens:
 *   Pass them with --registration-tokens tok1,tok2,...
 *
 * Usage:
 *   bun run packages/runner/src/matrixBootstrap.ts <scenario.yaml> \
 *     [--base-url http://localhost:8008] \
 *     [--registration-tokens tok1,tok2,...] \
 *     [--out credentials.yaml]
 */
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { AgentCredential, CredentialsFile } from "@agora/shared";
import { loadScenario } from "./loadConfig.js";
import { clientPath, csRequest } from "./matrixRooms.js";
import { createLogger } from "@agora/shared";

const log = createLogger("bootstrap");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const LLM_MODEL_ROTATION = ["deepseek-v4-flash-sovereign"];

function llmPlaceholderFor(index: number) {
  return {
    llmBaseUrl: "https://openrouter.ai/api/v1",
    llmApiKey: "PUT_OPENROUTER_KEY_HERE",
    llmModel: LLM_MODEL_ROTATION[index % LLM_MODEL_ROTATION.length]!,
  };
}

interface CliArgs {
  scenarioPath: string;
  baseUrl: string;
  registrationTokens: string[];
  outPath: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const scenarioPath = argv[0];
  if (!scenarioPath) {
    console.error(
      "Usage: bun run packages/runner/src/matrixBootstrap.ts <scenario.yaml> " +
      "[--base-url http://localhost:8008] [--registration-tokens tok1,tok2,...] [--out credentials.yaml]",
    );
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    scenarioPath,
    baseUrl: (flag("--base-url") ?? "http://localhost:8008").replace(/\/$/, ""),
    registrationTokens:
      flag("--registration-tokens")?.split(",").filter(Boolean) ?? [],
    outPath: flag("--out") ?? path.join(REPO_ROOT, "credentials.yaml"),
  };
}

interface RegisterResponse {
  user_id: string;
  access_token: string;
  home_server: string;
  device_id: string;
}

/**
 * Registers one account and sets its display name. The username gets a random
 * suffix so re-running the bootstrap never collides with an account an earlier
 * run created. The password is random and discarded: only the access token is
 * kept.
 */
async function registerAccount(
  baseUrl: string,
  accountId: string,
  registrationToken: string | undefined,
  displayName: string,
): Promise<{ userId: string; accessToken: string }> {
  const username =
    `agora-${accountId}-${Math.random().toString(36).slice(2, 7)}`.toLowerCase();
  const password = `Agora-${accountId}-${Math.random().toString(36).slice(2)}!`;

  const body: Record<string, unknown> = {
    username,
    password,
    auth: {
      type: "m.login.dummy",
    },
  };

  if (registrationToken) {
    body.auth = {
      type: "m.login.registration_token",
      token: registrationToken,
    };
  }

  const data = await csRequest<RegisterResponse>(
    baseUrl,
    "POST",
    // Register takes the shared path builder like every other call here: the
    // Client-Server API versions `register` with the rest, so it lives under the
    // same prefix. What is unusual about it is only that it is unauthenticated --
    // there is no account yet to hold a token -- which is why it is the one call
    // that passes no accessToken.
    clientPath("register"),
    { body },
  );

  // Set the displayname on the newly created account
  await csRequest(
    baseUrl,
    "PUT",
    clientPath(`profile/${encodeURIComponent(data.user_id)}/displayname`),
    { accessToken: data.access_token, body: { displayname: displayName } },
  );

  return { userId: data.user_id, accessToken: data.access_token };
}

async function loadExistingCredentials(
  outPath: string,
): Promise<Partial<CredentialsFile> | undefined> {
  try {
    return yaml.load(
      await readFile(outPath, "utf8"),
    ) as Partial<CredentialsFile>;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const scenario = await loadScenario(args.scenarioPath);
  const existing = await loadExistingCredentials(args.outPath);
  const tokenQueue = [...args.registrationTokens];
  const nextToken = (): string | undefined => tokenQueue.shift();

  log.info(`Provisioning Matrix against ${args.baseUrl} ...`);

  log.info("Registering setup account...");
  const setupAccount = await registerAccount(
    args.baseUrl,
    "setup",
    nextToken(),
    "Setup",
  );

  const agents: Record<string, AgentCredential> = {};

  for (const [index, agent] of scenario.agents.entries()) {
    log.info(`Registering account for agent "${agent.id}"...`);
    const account = await registerAccount(
      args.baseUrl,
      agent.id,
      nextToken(),
      agent.persona.displayName,
    );

    const existingAgentCred = existing?.agents?.[agent.id];
    const placeholder = llmPlaceholderFor(index);

    agents[agent.id] = {
      matrixAccessToken: account.accessToken,
      matrixUserId: account.userId,
      llmBaseUrl: existingAgentCred?.llmBaseUrl ?? placeholder.llmBaseUrl,
      llmApiKey: existingAgentCred?.llmApiKey ?? placeholder.llmApiKey,
      llmModel: existingAgentCred?.llmModel ?? placeholder.llmModel,
    };
  }

  // No room id here on purpose: the runner creates a room per Run and admits
  // these accounts to it at that point (ADR-0003).
  const credentials = {
    matrixSetupAccessToken: setupAccount.accessToken,
    matrixSetupUserId: setupAccount.userId,
    matrix: {
      hostBaseUrl: args.baseUrl,
      containerBaseUrl:
        existing?.matrix?.containerBaseUrl ?? "http://synapse:8008",
    },
    agents,
  };

  const header = `# Generated by matrixBootstrap.ts on ${new Date().toISOString()}\n# Fill in real llmApiKey values below before running a scenario.\n`;
  await writeFile(args.outPath, header + yaml.dump(credentials), "utf8");
  log.info(`Wrote ${args.outPath}`);
  log.info(
    "Fill in each agent's llmApiKey (and llmBaseUrl/llmModel if needed) before running a scenario.",
  );
}

main().catch((err) => {
  log.error("bootstrap failed:", err instanceof Error ? err.message : err);
  log.error(
    "If that was a registration error, check if registration is enabled on your Matrix homeserver or if a registration token is required.",
  );
  log.error("Re-run with --registration-tokens tok1,tok2,... if needed.");
  process.exit(1);
});
