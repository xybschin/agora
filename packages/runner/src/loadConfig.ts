/**
 * Loads the runner's inputs from disk: the Scenario, the credentials file, the
 * optional local Reader list, and (for bootstrap) Synapse's registration
 * shared secret. Validation lives in
 * `@agora/shared`; this module only adds the file reading and YAML parsing.
 */
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  loadScenarioConfig,
  matrixUserIdSchema,
  parseCredentialsFile,
} from "@agora/shared";

export const loadScenario = loadScenarioConfig;

/** Reads and validates `credentials.yaml`. Throws if the file is missing or fails the schema. */
export async function loadCredentials(filePath: string) {
  const raw = yaml.load(await readFile(filePath, "utf8"));
  return parseCredentialsFile(raw);
}

/**
 * Resolves the homeserver's `registration_shared_secret`, which bootstrap uses
 * to mint the server admin reclamation deletes rooms with (ADR-0009).
 *
 * `SYNAPSE_REGISTRATION_SHARED_SECRET` holds the value itself;
 * `SYNAPSE_REGISTRATION_SHARED_SECRET_FILE` names a file holding it -- the dev
 * stack's gitignored `docker/matrix/synapse/registration_shared_secret`, written
 * by `scripts/generate-synapse-secrets.sh`. Neither set returns undefined (no
 * admin is minted). A named file that is missing or empty throws, as does
 * setting both, because an operator who asked for a secret meant to get one.
 */
export async function readRegistrationSharedSecret(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const value = env.SYNAPSE_REGISTRATION_SHARED_SECRET;
  const file = env.SYNAPSE_REGISTRATION_SHARED_SECRET_FILE;
  if (value && file) {
    throw new Error(
      "Set only one of SYNAPSE_REGISTRATION_SHARED_SECRET and SYNAPSE_REGISTRATION_SHARED_SECRET_FILE, not both.",
    );
  }
  if (value) return value;
  if (!file) return undefined;
  const secret = (await readFile(file, "utf8")).trim();
  if (!secret) throw new Error(`${file} is empty; run scripts/generate-synapse-secrets.sh.`);
  return secret;
}

/**
 * Reads the git-ignored local Reader source (`readers.local.yaml`, the same
 * convention as `credentials.yaml`) that lets a local operator opt a human into
 * live Runs as a Reader. A missing file means no local Readers -- identical to a
 * Scenario that names none -- which is what lets the shipped Scenarios run on a
 * fresh clone without depending on an account that clone does not have.
 *
 * Only an absent file is read as "no Readers". A file that exists but cannot be
 * parsed (bad YAML, an entry that is not a well-formed Matrix user id) is a real
 * config error and is surfaced rather than silently ignored, because a local
 * operator who wrote one clearly meant it to be read.
 */
export async function loadLocalReaders(filePath: string): Promise<string[]> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const raw = yaml.load(rawText);
  return parseLocalReaders(raw, filePath);
}

function parseLocalReaders(raw: unknown, filePath: string): string[] {
  if (raw === null || raw === undefined || raw === "") {
    // An empty file is a fine way to say "no local Readers".
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      `${filePath} should be a list of Matrix user ids, one per entry; got ${JSON.stringify(raw)}`,
    );
  }
  return raw.map((entry, index) => {
    const parsed = matrixUserIdSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `${filePath} entry ${index + 1} (${JSON.stringify(entry)}) is not a well-formed Matrix user id like @localpart:server`,
      );
    }
    return parsed.data;
  });
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
