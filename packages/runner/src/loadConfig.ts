import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  loadScenarioConfig,
  matrixUserIdSchema,
  parseCredentialsFile,
} from "@agora/shared";

export const loadScenario = loadScenarioConfig;

export async function loadCredentials(filePath: string) {
  const raw = yaml.load(await readFile(filePath, "utf8"));
  return parseCredentialsFile(raw);
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
