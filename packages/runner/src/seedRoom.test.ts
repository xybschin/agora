import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { seedRoom } from "./seedRoom.js";

// The room is new for every Run (ADR-0003), so the seed goes into the room the
// runner just created rather than into whatever the credentials file happened to
// point at. Two things follow, and both are asserted here: the seed lands in the
// room id the runner passed in, and posting it takes exactly one call -- the
// "is the seed already there?" read that guarded a shared room is gone.

interface FetchCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
});

function stubHomeserver(
  respond: (call: FetchCall) => Response = () =>
    new Response(JSON.stringify({ event_id: "$seed" })),
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  type FetchFn = typeof globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      authorization: headers["Authorization"],
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  }) as FetchFn;
  restore.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const scenario: ScenarioConfig = {
  name: "remote-work-policy",
  topic: "Should remote work stay optional?",
  seedMessage: "The floor is yours.",
  seedAuthor: "bri",
  maxRuntimeMs: 120000,
  maxToolStepsPerTurn: 6,
  budget: {},
  agents: ["alex", "bri"].map((id) => ({
    id,
    persona: {
      displayName: id,
      flavorText: "",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0,
    },
  })),
};

const credentials: CredentialsFile = {
  matrixSetupAccessToken: "syt_setup",
  matrixSetupUserId: "@agora-setup:localhost",
  matrix: {
    hostBaseUrl: "http://localhost:8008",
    containerBaseUrl: "http://synapse:8008",
  },
  agents: {
    alex: {
      matrixAccessToken: "syt_alex",
      matrixUserId: "@agora-alex:localhost",
      llmBaseUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "deepseek-v4-flash-sovereign",
    },
    bri: {
      matrixAccessToken: "syt_bri",
      matrixUserId: "@agora-bri:localhost",
      llmBaseUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "deepseek-v4-flash-sovereign",
    },
  },
};

describe("seedRoom", () => {
  test("posts the Scenario's seed into the Run's room, as the seed author", async () => {
    const calls = stubHomeserver();

    await seedRoom({ scenario, credentials, roomId: "!run1:localhost" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.authorization).toBe("Bearer syt_bri");
    expect(calls[0]?.url).toMatch(
      /^http:\/\/localhost:8008\/_matrix\/client\/v3\/rooms\/!run1%3Alocalhost\/send\/m\.room\.message\/.+$/,
    );
    expect(calls[0]?.body).toEqual({
      msgtype: "m.text",
      body: "The floor is yours.",
    });
  });

  // The setup account is the Moderator. Were the seed posted with its token, the
  // Moderator would read the seed as its own message -- a question it asked that
  // nobody answered -- and the seed author would not recognize it as theirs.
  test("never posts with the setup account, which is the Moderator", async () => {
    const calls = stubHomeserver();

    await seedRoom({ scenario, credentials, roomId: "!run4:localhost" });

    expect(calls.some((call) => call.authorization === "Bearer syt_setup")).toBe(
      false,
    );
  });

  test("makes no read of the room first, because a Run's room is always new", async () => {
    const calls = stubHomeserver();

    await seedRoom({ scenario, credentials, roomId: "!run2:localhost" });

    expect(calls.some((call) => call.method === "GET")).toBe(false);
    expect(calls.some((call) => call.url.includes("/messages"))).toBe(false);
  });

  // The seed goes through the same request seam as room creation, the invites and
  // the power levels, so a homeserver refusal reads the same way wherever in the
  // Run's setup it happens -- and it names the whole Client-Server path, prefix
  // included, so the message says which endpoint was refused without the reader
  // having to know which module issued it.
  test("surfaces a homeserver refusal through the shared request seam", async () => {
    stubHomeserver(
      () => new Response("M_FORBIDDEN: not in this room", { status: 403 }),
    );

    const error = await seedRoom({
      scenario,
      credentials,
      roomId: "!run3:localhost",
    }).then(
      () => new Error("expected the seed to be refused, but it was accepted"),
      (err: unknown) => err as Error,
    );

    expect(error.message).toContain(
      "PUT /_matrix/client/v3/rooms/!run3%3Alocalhost/send/m.room.message/",
    );
    expect(error.message).toMatch(/ -> HTTP 403: M_FORBIDDEN: not in this room$/);
  });
});
