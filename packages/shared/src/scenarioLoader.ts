import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { ScenarioConfig } from "./types.js";
import { parseScenarioConfig } from "./schema.js";

export async function loadScenarioConfig(filePath: string): Promise<ScenarioConfig> {
  const raw = yaml.load(await readFile(filePath, "utf8"));
  return parseScenarioConfig(raw);
}
