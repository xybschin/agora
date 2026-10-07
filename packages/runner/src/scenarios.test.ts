import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "./loadConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, "../../../scenarios");

// The shipped Scenarios are fixtures of scenarioConfigSchema, the same way
// credentials.example.yaml is a fixture of credentialsFileSchema (see
// loadConfig.test.ts). Each one is read through loadScenario so the test covers
// the path the runner actually hits: the file on disk, yaml.load, then the
// schema. A schema change that strands a shipped Scenario fails here.
//
// Only loadability is asserted, never content. Scenarios are data that gets
// tuned between Runs; pinning their values would only make every edit a test
// change.
const scenarioFiles = readdirSync(SCENARIOS_DIR).filter((f) => /\.ya?ml$/.test(f));

describe("shipped scenarios", () => {
  test("the scenarios directory is not empty", () => {
    expect(scenarioFiles.length).toBeGreaterThan(0);
  });

  test.each(scenarioFiles)("%s loads through the runner's load path", async (file) => {
    const scenario = await loadScenario(path.join(SCENARIOS_DIR, file));
    expect(scenario.agents.length).toBeGreaterThan(0);
  });
});
