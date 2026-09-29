import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { loadScenarioConfig, parseCredentialsFile } from "@agora/shared";

export const loadScenario = loadScenarioConfig;

export async function loadCredentials(filePath: string) {
  const raw = yaml.load(await readFile(filePath, "utf8"));
  return parseCredentialsFile(raw);
}
