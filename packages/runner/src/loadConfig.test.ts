import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentials } from "./loadConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = path.resolve(__dirname, "../../../credentials.example.yaml");

// credentials.example.yaml is the route into a hosted Matrix for anyone not
// running the bootstrap script: copy it to credentials.yaml and fill it in. So
// it is a fixture of credentialsFileSchema, and it has to parse -- a
// copy-and-fill file the loader rejects is a defect, and nothing else in the
// repo would notice, because the bootstrap's output is covered by shape rather
// than by file.
//
// Read through loadCredentials rather than parseCredentialsFile alone, so the
// test covers the path the user actually hits: the file on disk, yaml.load, then
// the schema. A hand-built object would skip the disk and the YAML parser, and
// those are two of the three places a template can be wrong.
//
// The path leaves the package, which is worth naming. It is not a new
// convention: index.ts and matrixBootstrap.ts both resolve the same "../../.."
// to find credentials.yaml, so the runner already depends on credentials living
// at the repo root. Move that file and this test fails in the same place the
// runner does, rather than quietly pointing at nothing.
describe("credentials.example.yaml", () => {
  test("parses as a credentials file, placeholders and all", async () => {
    // The placeholder strings are what makes this worth a strict parse: they
    // are only real values to a human, and a template is most likely to drift
    // exactly where nobody ever runs it.
    const credentials = await loadCredentials(EXAMPLE_PATH);
    expect(credentials.matrixSetupUserId).toBe("@agora-setup:localhost");
    expect(credentials.matrix.hostBaseUrl).toBe("http://localhost:8000");
    expect(credentials.agents["alex"]?.matrixUserId).toBe("@alex:localhost");
  });

  test("gives every agent all five credential fields", async () => {
    // The record parse above already rejects a short entry, so this is not a
    // second opinion on the same fact. It is here to name the field that is
    // missing: the failure a hosted-Matrix user hits after copying the file
    // should be this sentence, not a zod path.
    const credentials = await loadCredentials(EXAMPLE_PATH);
    const fields = [
      "matrixAccessToken",
      "matrixUserId",
      "llmBaseUrl",
      "llmApiKey",
      "llmModel",
    ] as const;
    for (const [id, agent] of Object.entries(credentials.agents)) {
      for (const field of fields) {
        expect(agent[field], `${id} is missing ${field}`).toBeTruthy();
      }
    }
  });
});
