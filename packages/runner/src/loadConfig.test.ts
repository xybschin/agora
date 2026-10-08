// Pins the runner's config loading against real files on disk: the shipped
// credentials template must parse, and the local Reader list must treat absence
// and emptiness as "no Readers" while rejecting anything malformed.
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, loadLocalReaders, readRegistrationSharedSecret } from "./loadConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = path.resolve(__dirname, "../../../credentials.example.yaml");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp dir, tracked so afterEach can remove it. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agora-loadconfig-"));
  dirs.push(dir);
  return dir;
}

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

describe("loadLocalReaders", () => {
  test("a missing local file means no Readers, so a fresh clone runs with none", async () => {
    // The local source is git-ignored, so on a fresh clone it is absent. A
    // missing file must read as no Readers -- identical to a Scenario that names
    // none -- not as an error, or every clone would die before its room exists.
    const dir = freshDir();
    // A real readers.local.yaml may sit at the repo root; this test points at a
    // path that cannot exist, so it is unaffected.
    const filename = join(dir, `missing-${Date.now()}.yaml`);
    expect(await loadLocalReaders(filename)).toEqual([]);
  });

  test("reads a local file's list of Matrix user ids as Readers", async () => {
    const dir = freshDir();
    const filename = join(dir, "readers.local.yaml");
    writeFileSync(
      filename,
      [
        "# local Readers for this machine",
        '- "@human:localhost"',
        '- "@domain-expert:matrix.example.org"',
        "",
      ].join("\n"),
      "utf8",
    );
    expect(await loadLocalReaders(filename)).toEqual([
      "@human:localhost",
      "@domain-expert:matrix.example.org",
    ]);
  });

  test("an empty file is a fine way to say no local Readers", async () => {
    const dir = freshDir();
    const filename = join(dir, "readers.local.yaml");
    writeFileSync(filename, "", "utf8");
    expect(await loadLocalReaders(filename)).toEqual([]);
  });

  test("a malformed entry is a config error, not a silent skip", async () => {
    const dir = freshDir();
    const filename = join(dir, "readers.local.yaml");
    writeFileSync(filename, "- not-a-user-id\n", "utf8");
    expect(() => loadLocalReaders(filename)).toThrow(/not a well-formed Matrix user id/);
  });

  test("a non-list file is a config error, not a silent skip", async () => {
    const dir = freshDir();
    const filename = join(dir, "readers.local.yaml");
    writeFileSync(filename, "observers: [\"@human:localhost\"]\n", "utf8");
    expect(() => loadLocalReaders(filename)).toThrow(/should be a list of Matrix user ids/);
  });
});

// Bootstrap mints the server admin from Synapse's registration_shared_secret
// (ADR-0009). The dev stack keeps that secret in a gitignored file, so the file
// form is the normal one; the variable form stays for hosted homeservers.
describe("readRegistrationSharedSecret", () => {
  test("is undefined when neither variable is set, so no admin is minted", async () => {
    expect(await readRegistrationSharedSecret({})).toBeUndefined();
  });

  test("takes the secret from SYNAPSE_REGISTRATION_SHARED_SECRET", async () => {
    expect(await readRegistrationSharedSecret({ SYNAPSE_REGISTRATION_SHARED_SECRET: "s3cret" })).toBe("s3cret");
  });

  test("reads the file SYNAPSE_REGISTRATION_SHARED_SECRET_FILE names, trimming a trailing newline", async () => {
    const file = join(freshDir(), "registration_shared_secret");
    writeFileSync(file, "abc123\n");
    expect(await readRegistrationSharedSecret({ SYNAPSE_REGISTRATION_SHARED_SECRET_FILE: file })).toBe("abc123");
  });

  test("fails on a named file that is missing or empty rather than silently minting nothing", async () => {
    const dir = freshDir();
    await expect(
      readRegistrationSharedSecret({ SYNAPSE_REGISTRATION_SHARED_SECRET_FILE: join(dir, "nope") }),
    ).rejects.toThrow();
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    await expect(
      readRegistrationSharedSecret({ SYNAPSE_REGISTRATION_SHARED_SECRET_FILE: empty }),
    ).rejects.toThrow(/empty/);
  });

  test("refuses both variables at once instead of guessing which one wins", async () => {
    await expect(
      readRegistrationSharedSecret({
        SYNAPSE_REGISTRATION_SHARED_SECRET: "a",
        SYNAPSE_REGISTRATION_SHARED_SECRET_FILE: "/x",
      }),
    ).rejects.toThrow(/both/);
  });
});
