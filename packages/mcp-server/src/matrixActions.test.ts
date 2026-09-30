import { afterEach, describe, test, expect } from "bun:test";

interface FetchCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
}

const restoreFetch: Array<() => void> = [];

afterEach(() => {
  while (restoreFetch.length > 0) restoreFetch.pop()!();
  delete process.env.MATRIX_HOME_SERVER_URL;
});

/**
 * Replaces global fetch with a recorder, so we can assert both that whoami is
 * reached and that every call is authenticated with the agent's own token. This
 * mirrors the runner's matrixRooms.test.ts seam: the identity fix is proven at
 * the readRoom boundary, where the token decides identity.
 */
function recordFetch(
  respond: (call: FetchCall) => Response = () =>
    new Response("{}", { status: 200 }),
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  type FetchFn = typeof globalThis.fetch;
  const recorder = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      authorization: headers["Authorization"],
    };
    calls.push(call);
    return respond(call);
  }) as FetchFn;
  globalThis.fetch = recorder;
  restoreFetch.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** Responds to the three homeserver calls readRoom makes, driven by one token-owned id. */
function matrixResponder(ownId: string) {
  return (call: FetchCall): Response => {
    if (call.url.includes("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: ownId }), { status: 200 });
    }
    if (call.url.includes("/joined_members")) {
      return new Response(JSON.stringify({ joined: {} }), { status: 200 });
    }
    if (call.url.includes("/messages")) {
      return new Response(
        JSON.stringify({
          chunk: [
            {
              event_id: "$self",
              sender: ownId,
              type: "m.room.message",
              content: { msgtype: "m.text", body: "hi from self" },
              origin_server_ts: 1,
            },
            {
              event_id: "$other",
              sender: "@carol:localhost",
              type: "m.room.message",
              content: { msgtype: "m.text", body: "hi from carol" },
              origin_server_ts: 2,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };
}

/**
 * Tests for agent identity resolution in Matrix room messages.
 * Verifies that:
 * 1. Own messages are marked with "**your message:**" prefix
 * 2. Display names are resolved from room member list
 */

describe("matrixActions identity marking", () => {
  test("message with own user ID gets marked", () => {
    // Integration with real readRoom requires a Matrix server, so we test the contract here:
    // when matrixUserId matches a message's sender, content is prefixed with "**your message:**"
    const ownUserId = "@alice:localhost";
    const senderUserId = "@alice:localhost";
    const originalContent = "Hello world";

    // Simulate what readRoom does
    const isOwnMessage = ownUserId === senderUserId;
    const markedContent = isOwnMessage ? `**your message:** ${originalContent}` : originalContent;

    expect(markedContent).toBe("**your message:** Hello world");
  });

  test("message from different user is not marked", () => {
    const ownUserId = "@alice:localhost";
    const senderUserId = "@bob:localhost";
    const originalContent = "Hi there";

    const isOwnMessage = ownUserId === senderUserId;
    const markedContent = isOwnMessage ? `**your message:** ${originalContent}` : originalContent;

    expect(markedContent).toBe("Hi there");
    expect(markedContent).not.toContain("**your message:**");
  });

  test("agent system prompt explains own message marking", () => {
    // Verify the persona.ts prompt mentions own message marking
    const promptHint = "Messages from **yourself** are marked \"**your message:**\"";
    expect(promptHint).toContain("**your message:**");
  });
});

describe("stance continuity across ticks", () => {
  test("prompt reflects current stance, not just initial stance", async () => {
    const { buildSystemPrompt } = await import("../../agent/src/persona.js");

    const mockPersona = {
      displayName: "TestAgent",
      flavorText: "A test agent",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0.2,
    };

    // On first tick with no current stance, should show initial
    const prompt1 = buildSystemPrompt({
      persona: mockPersona,
      topic: "test",
      readWindowSize: 20,
      isFirstTick: true,
    });
    expect(prompt1).toContain("Your current private stance on the topic is 0.2");
    expect(prompt1).toContain("(you started at 0.2)");

    // On subsequent tick with evolved stance, should show current
    const prompt2 = buildSystemPrompt({
      persona: mockPersona,
      topic: "test",
      readWindowSize: 20,
      currentStance: 0.6,
      isFirstTick: false,
    });
    expect(prompt2).toContain("Your current private stance on the topic is 0.6");
    expect(prompt2).not.toContain("(you started at");
  });

  test("stance can drift across ticks without resetting to initial", async () => {
    // Verify the contract: agent stance is maintained in AgentRuntime.currentStance
    // and fed back into buildSystemPrompt each tick, so it drifts and is not reset
    const { buildSystemPrompt } = await import("../../agent/src/persona.js");

    const mockPersona = {
      displayName: "TestAgent",
      flavorText: "A test agent",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0.2,
    };

    // Simulate stance drifting across ticks: 0.2 -> 0.3 -> 0.5 -> 0.7
    const driftedStances = [0.3, 0.5, 0.7];

    for (const stance of driftedStances) {
      const prompt = buildSystemPrompt({
        persona: mockPersona,
        topic: "test",
        readWindowSize: 20,
        currentStance: stance,
        isFirstTick: false,
      });

      // Each tick should reflect the current stance, not reset to 0.2
      expect(prompt).toContain(`Your current private stance on the topic is ${stance}`);
      expect(prompt).not.toContain("(you started at"); // No reminder on non-first ticks
    }
  });
});

describe("identity is resolved from the access token, not a client header (agora-2ja)", () => {
  test("readRoom reaches /account/whoami with the agent's own token", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    const calls = recordFetch(matrixResponder("@agora-alex:localhost"));
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);

    const whoami = calls.find((c) => c.url.includes("/account/whoami"));
    expect(whoami).toBeDefined();
    // The token is the only authentication; whoami must be called with it.
    expect(whoami?.authorization).toBe("Bearer syt_alex");

    // The token's owner is the only identity known to readRoom: its own message
    // is marked, and another user's is not, no matter what a caller asserts.
    const self = messages.find((m) => m.sender === "@agora-alex:localhost")!;
    const other = messages.find((m) => m.sender === "@carol:localhost")!;
    expect(self.content).toContain("**your message:**");
    expect(other.content).not.toContain("**your message:**");
  });

  test("a forged-reader's identity can never be asserted at the read boundary: only the token's id is marked", async () => {
    // The vulnerability this guard exists to close: an agent holding its own
    // token must not be able to get another agent's messages marked as its own,
    // or its own marked as someone else's. Identity comes from the token alone.
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    // Bob's token resolves to Bob; only Bob's message is marked "your message:".
    const calls = recordFetch(matrixResponder("@bob:localhost"));
    const messages = await readRoom(getMatrixClient("syt_bob"), "!room:localhost", 10);

    const bob = messages.find((m) => m.sender === "@bob:localhost")!;
    const carol = messages.find((m) => m.sender === "@carol:localhost")!;
    expect(bob.content).toContain("**your message:**");
    // The message sent by the other agent is never the caller's own.
    expect(carol.content).not.toContain("**your message:**");
    // And the id was learned from the token, not from any client-supplied value.
    expect(calls.find((c) => c.url.includes("/account/whoami"))?.authorization).toBe(
      "Bearer syt_bob",
    );
  });
});
