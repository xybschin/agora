/**
 * Loads a Scenario from disk. Kept separate from schema.ts so the schema stays
 * free of file I/O; the runner re-exports this as `loadScenario`
 * (packages/runner/src/loadConfig.ts).
 */
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { ScenarioConfig } from "./types.js";
import { parseScenarioConfig } from "./schema.js";

/**
 * Reads a Scenario YAML file (`scenarios/<name>.yaml`) and validates it with
 * parseScenarioConfig, so an invalid or tick-era Scenario fails here with the
 * schema's error rather than later inside a Run. Throws on unreadable files,
 * malformed YAML, and schema violations alike.
 */
export async function loadScenarioConfig(filePath: string): Promise<ScenarioConfig> {
  const raw = yaml.load(await readFile(filePath, "utf8"));
  return parseScenarioConfig(raw);
}
