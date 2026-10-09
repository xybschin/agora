// Pins matrixActions' contracts against a recorded fetch: readRoom marks only
// the token owner's messages as its own, resolves display names and shows
// Replies with their fallback quote swapped for a short replyTo,
// waitForActivity long-polls /sync without ever sending the room id,
// sendMessage quotes the original in a rich reply (or degrades to a bare
// reply), and stripQuote drops agent-written quotes. Two suites also check the agent's system prompt
// (persona.ts), because the own-message marking and stance only work if the
// prompt explains them.
import { afterEach, describe, test, expect } from "bun:test";
import { sendMessage, stripQuote } from "./matrixActions.js";

interface FetchCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  /** The request body string (for POST/PUT calls), useful for asserting payloads. */
  body: string | undefined;
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
      body: typeof init?.body === "string" ? init.body : undefined,
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
      // Spec-shaped /joined_members: a FLAT member object per user with
      // display_name (no `content` wrapper). A populated map lets readRoom's
      // display-name lookup actually execute. See agora-ber.
      return new Response(
        JSON.stringify({
          joined: {
            [ownId]: { display_name: "Alex Danvers", avatar_url: undefined },
            "@carol:localhost": { display_name: "Carol Danvers", avatar_url: undefined },
          },
        }),
        { status: 200 },
      );
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
 * 2. Messages from other users are not marked
 * 3. The agent system prompt tells the agent how its own messages are marked
 *
 * These drive the real readRoom (via the fetch-recording seam shared with the
 * agora-2ja block) rather than re-implementing readRoom's marking inline: the
 * old tests compared const string literals, which both tautologically passed
 * regardless of readRoom's behavior and one of which TypeScript rejects as
 * TS2367. Marking is now proven against readRoom's own comparison, so a
 * regression in readRoom's own-message logic fails the suite.
 */

describe("matrixActions identity marking", () => {
  test("message with the caller's own user ID gets marked", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    recordFetch(matrixResponder("@agora-alex:localhost"));
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);

    const self = messages.find((m) => m.sender === "@agora-alex:localhost")!;
    // The token's owner is the only identity readRoom knows: its own message is
    // marked with the "**your message:**" prefix.
    expect(self.content).toContain("**your message:**");
  });

  test("message from a different user is not marked", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    recordFetch(matrixResponder("@agora-alex:localhost"));
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);

    const other = messages.find((m) => m.sender === "@carol:localhost")!;
    // A message sent by someone other than the token's owner is never marked.
    expect(other.content).not.toContain("**your message:**");
  });

  test("agent system prompt explains own message marking", async () => {
    // Read the real prompt from the agent persona builder, not a copied literal.
    const { buildSystemPrompt } = await import("../../agent/src/persona.js");
    const prompt = buildSystemPrompt({
      persona: {
        displayName: "TestAgent",
        flavorText: "A test agent",
        traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
        initialStance: 0.2,
      },
      topic: "test",
    });
    expect(prompt).toContain(
      'Messages from **yourself** are marked "**your message:**"',
    );
  });
});

describe("stance continuity across turns", () => {
  test("prompt reflects current stance, not just initial stance", async () => {
    const { buildSystemPrompt } = await import("../../agent/src/persona.js");

    const mockPersona = {
      displayName: "TestAgent",
      flavorText: "A test agent",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0.2,
    };

    // On the agent's first turn (isFirstTurn) with no current stance, the
    // prompt shows the initial stance.
    const prompt1 = buildSystemPrompt({
      persona: mockPersona,
      topic: "test",
      isFirstTurn: true,
    });
    expect(prompt1).toContain("Your current private stance on the topic is 0.2");
    expect(prompt1).toContain("(you started at 0.2)");

    // On later turns with an evolved stance, it shows the current one.
    const prompt2 = buildSystemPrompt({
      persona: mockPersona,
      topic: "test",
      currentStance: 0.6,
      isFirstTurn: false,
    });
    expect(prompt2).toContain("Your current private stance on the topic is 0.6");
    expect(prompt2).not.toContain("(you started at");
  });

  test("stance can drift across turns without resetting to initial", async () => {
    // The contract: AgentRuntime (loop.ts) keeps the agent's current stance and
    // feeds it back into buildSystemPrompt each turn, so it drifts and is not
    // reset.
    const { buildSystemPrompt } = await import("../../agent/src/persona.js");

    const mockPersona = {
      displayName: "TestAgent",
      flavorText: "A test agent",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: 0.2,
    };

    // Simulate stance drifting across turns: 0.2 -> 0.3 -> 0.5 -> 0.7
    const driftedStances = [0.3, 0.5, 0.7];

    for (const stance of driftedStances) {
      const prompt = buildSystemPrompt({
        persona: mockPersona,
        topic: "test",
        currentStance: stance,
        isFirstTurn: false,
      });

      // Each turn reflects the current stance, not a reset to the initial one.
      expect(prompt).toContain(`Your current private stance on the topic is ${stance}`);
      expect(prompt).not.toContain("(you started at"); // No reminder after the first turn
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

  test("senderDisplayName resolves display_name from the flat /joined_members object (agora-ber)", async () => {
    // The bug: readRoom read member.content?.displayname (the state-event shape),
    // but /joined_members returns a flat { display_name } per user -- so display
    // names always fell back to the raw user id. The seam now returns a populated
    // flat map, so this test proves the lookup executes and lands on the name.
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    recordFetch(matrixResponder("@agora-alex:localhost"));
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);

    const self = messages.find((m) => m.sender === "@agora-alex:localhost")!;
    const carol = messages.find((m) => m.sender === "@carol:localhost")!;
    expect(carol.senderDisplayName).toBe("Carol Danvers");
    expect(self.senderDisplayName).toBe("Alex Danvers");
  });

  test("a member with no display_name falls back to the raw user id (agora-ber)", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");

    // A member present in the room with no display_name must not produce
    // "undefined" -- it falls back to the user id.
    const noNameResponder = (call: FetchCall): Response => {
      if (call.url.includes("/account/whoami")) {
        return new Response(JSON.stringify({ user_id: "@agora-alex:localhost" }), {
          status: 200,
        });
      }
      if (call.url.includes("/joined_members")) {
        return new Response(
          JSON.stringify({
            joined: { "@agora-alex:localhost": { avatar_url: undefined } },
          }),
          { status: 200 },
        );
      }
      if (call.url.includes("/messages")) {
        return new Response(
          JSON.stringify({
            chunk: [
              {
                event_id: "$self",
                sender: "@agora-alex:localhost",
                type: "m.room.message",
                content: { msgtype: "m.text", body: "hi" },
                origin_server_ts: 1,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    recordFetch(noNameResponder);
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);

    const self = messages.find((m) => m.sender === "@agora-alex:localhost")!;
    expect(self.senderDisplayName).toBe("@agora-alex:localhost");
  });
});

describe("readRoom shows Replies compactly (agora-jb3.3)", () => {
  /** Reads a room holding `events` as @agora-alex, with Carol named in the member list. */
  async function readEvents(events: unknown[]) {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { readRoom } = await import("./matrixActions.js");
    const base = matrixResponder("@agora-alex:localhost");
    const calls = recordFetch((call) =>
      call.url.includes("/messages")
        ? new Response(JSON.stringify({ chunk: [...events].reverse() }), { status: 200 })
        : base(call),
    );
    const messages = await readRoom(getMatrixClient("syt_alex"), "!room:localhost", 10);
    return { messages, calls };
  }

  function reply(eventId: string, sender: string, body: string, target = "$orig") {
    return {
      event_id: eventId,
      sender,
      type: "m.room.message",
      content: { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: target } } },
      origin_server_ts: 1,
    };
  }

  test("strips a multi-line fallback and names the original's sender", async () => {
    // The shape replyFallback writes: sender on its own line, a blank original
    // line quoted as "> ", then one blank line before the reply.
    const body = "> <@carol:localhost>\n> First line.\n> \n> Third line.\n\nI disagree.";
    const { messages, calls } = await readEvents([reply("$r", "@bob:localhost", body)]);

    expect(messages[0]!.content).toBe("I disagree.");
    expect(messages[0]!.replyTo).toEqual({
      eventId: "$orig",
      senderDisplayName: "Carol Danvers",
      excerpt: "First line. Third line.",
    });
    // The excerpt comes from the quote itself, never from fetching the original.
    expect(calls.some((c) => c.url.includes("/event/"))).toBe(false);
  });

  test("keeps a multi-line reply after the fallback intact", async () => {
    const body = "> <@carol:localhost>\n> hi\n\nline one\n\nline two";
    const { messages } = await readEvents([reply("$r", "@bob:localhost", body)]);
    expect(messages[0]!.content).toBe("line one\n\nline two");
  });

  test("truncates a long original to an 80-character excerpt with an ellipsis", async () => {
    const original = "word ".repeat(40).trim();
    const body = `> <@carol:localhost>\n> ${original}\n\nok`;
    const { messages } = await readEvents([reply("$r", "@bob:localhost", body)]);

    const excerpt = messages[0]!.replyTo!.excerpt!;
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(original.startsWith(excerpt.slice(0, -1))).toBe(true);
  });

  test("reads the sender from a fallback that shares its line with the original", async () => {
    // Other clients (e.g. Element) put the original's first line after the sender.
    const body = "> <@dave:localhost> Opening line\n> second\n\nreply";
    const { messages } = await readEvents([reply("$r", "@bob:localhost", body)]);

    expect(messages[0]!.content).toBe("reply");
    // Dave is not in the member list, so the raw user id stands in.
    expect(messages[0]!.replyTo).toEqual({
      eventId: "$orig",
      senderDisplayName: "@dave:localhost",
      excerpt: "Opening line second",
    });
  });

  test("a Reply without a fallback keeps its body and carries only the target id", async () => {
    const { messages } = await readEvents([reply("$r", "@bob:localhost", "> not a fallback\n\nbody")]);
    expect(messages[0]!.content).toBe("> not a fallback\n\nbody");
    expect(messages[0]!.replyTo).toEqual({ eventId: "$orig" });
  });

  test("a non-reply is passed through unchanged, with no replyTo", async () => {
    const quoteLike = "> <@carol:localhost>\n> looks like a quote\n\nbut is not a Reply";
    const { messages } = await readEvents([
      {
        event_id: "$plain",
        sender: "@bob:localhost",
        type: "m.room.message",
        content: { msgtype: "m.text", body: quoteLike },
        origin_server_ts: 1,
      },
    ]);
    expect(messages[0]!.content).toBe(quoteLike);
    expect("replyTo" in messages[0]!).toBe(false);
  });

  test("the caller's own Reply is stripped and still marked as its own", async () => {
    const body = "> <@carol:localhost>\n> hi from carol\n\nhi back";
    const { messages } = await readEvents([reply("$r", "@agora-alex:localhost", body)]);

    expect(messages[0]!.content).toBe("**your message:** hi back");
    expect(messages[0]!.replyTo).toEqual({
      eventId: "$orig",
      senderDisplayName: "Carol Danvers",
      excerpt: "hi from carol",
    });
  });
});

describe("matrixActions waitForActivity long-poll", () => {
  // A /sync responder that returns the given joined-room timeline events and a
  // next_batch token, defaulting to no activity in the room.
  function syncResponder(events: unknown[], nextBatch: string) {
    return (call: FetchCall): Response => {
      if (call.url.includes("/sync")) {
        return new Response(
          JSON.stringify({
            next_batch: nextBatch,
            rooms: events.length > 0 ? { join: { "!room:localhost": { timeline: { events } } } } : {},
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };
  }

  test("returns hasActivity true and the next_batch token when activity is present", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { waitForActivity } = await import("./matrixActions.js");

    const calls = recordFetch(syncResponder([{ event_id: "$e1" }], "s2"));
    const result = await waitForActivity(
      getMatrixClient("syt_alex"),
      "!room:localhost",
      30_000,
      "s1",
    );

    expect(result.hasActivity).toBe(true);
    expect(result.nextBatch).toBe("s2");

    // The long-poll request carries the timeout and resume token and a
    // message/reaction filter -- and, crucially, NO room id. The room is bound
    // to the server by MATRIX_ROOM_ID and never travels over the wire as a
    // model-supplied argument.
    const sync = calls.find((c) => c.url.includes("/sync"))!;
    expect(sync.method).toBe("GET");
    expect(sync.url).toContain("timeout=30000");
    expect(sync.url).toContain("since=s1");
    expect(sync.url).toContain("m.room.message");
    expect(sync.url).toContain("m.reaction");
    expect(sync.url).not.toContain("!room:localhost");
  });

  test("a timed-out wait with nothing new is a normal success, not an error", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { waitForActivity } = await import("./matrixActions.js");

    // No joined room / no timeline events: nothing new arrived by the timeout.
    const calls = recordFetch(syncResponder([], "s5"));
    const result = await waitForActivity(
      getMatrixClient("syt_alex"),
      "!room:localhost",
      30_000,
      "s4",
    );

    // Still a peer of the happy path: hasActivity false, but the token advances
    // so the next wait resumes from here rather than re-reading everything.
    expect(result.hasActivity).toBe(false);
    expect(result.nextBatch).toBe("s5");
    expect(calls.find((c) => c.url.includes("/sync"))?.authorization).toBe("Bearer syt_alex");
  });

  test("never sends a room id across any wait, even without a since token", async () => {
    process.env.MATRIX_HOME_SERVER_URL = "http://synapse:8008";
    const { getMatrixClient } = await import("./matrixPool.js");
    const { waitForActivity } = await import("./matrixActions.js");

    // First wait of a run: no `since` resume token at all.
    const calls = recordFetch(syncResponder([{ event_id: "$e2" }], "s2"));
    const result = await waitForActivity(getMatrixClient("syt_alex"), "!room:localhost", 30_000);

    expect(result.hasActivity).toBe(true);
    const sync = calls.find((c) => c.url.includes("/sync"))!;
    expect(sync.url).not.toContain("since=");
    expect(sync.url).not.toContain("!room:localhost");
    expect(sync.url).not.toContain("roomId");
  });
});

describe("matrixActions sendMessage rich reply fallback", () => {
  const client = { homeServerUrl: "https://hs.example", accessToken: "tok" };

  test("reply quotes the original message instead of '<no-fallback>'", async () => {
    const calls = recordFetch((call) => {
      if (call.url.includes("/event/")) {
        // The replied-to event, as the homeserver returns it.
        return new Response(
          JSON.stringify({
            sender: "@carol:localhost",
            content: { msgtype: "m.text", body: "hi from carol" },
          }),
          { status: 200 },
        );
      }
      if (call.url.includes("/send/m.room.message/")) {
        return new Response(JSON.stringify({ event_id: "$sent" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    await sendMessage(client, "!room:localhost", "and my reply", "$original");

    const send = calls.find((c) => c.url.includes("/send/m.room.message/"));
    expect(send).toBeDefined();
    const payload = JSON.parse(send!.body!);
    expect(payload["m.relates_to"]["m.in_reply_to"].event_id).toBe("$original");
    expect(payload.body).toContain("> <@carol:localhost>");
    expect(payload.body).toContain("> hi from carol");
    expect(payload.body).toContain("and my reply");
    expect(payload.body).not.toContain("<no-fallback>");
  });

  test("fetch failure degrades to a bare reply with no fallback placeholder", async () => {
    const calls = recordFetch((call) => {
      if (call.url.includes("/event/")) {
        return new Response("{}", { status: 404 });
      }
      if (call.url.includes("/send/m.room.message/")) {
        return new Response(JSON.stringify({ event_id: "$sent" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    await sendMessage(client, "!room:localhost", "and my reply", "$original");

    const send = calls.find((c) => c.url.includes("/send/m.room.message/"));
    expect(send).toBeDefined();
    const payload = JSON.parse(send!.body!);
    // Relation is still attached, but no quote placeholder pollutes the body.
    expect(payload["m.relates_to"]["m.in_reply_to"].event_id).toBe("$original");
    expect(payload.body).toBe("and my reply");
    expect(payload.body).not.toContain("<no-fallback>");
  });
});

describe("matrixActions sendMessage without a reply target", () => {
  const client = { homeServerUrl: "https://hs.example", accessToken: "tok" };

  test("a Room post is a plain message: no relation, no quote fetch", async () => {
    // matrix_post sends with no target, so nothing may make it look like a
    // Reply in the room: a missing reply link must mean a Room post (ADR-0010).
    const calls = recordFetch((call) => {
      if (call.url.includes("/send/m.room.message/")) {
        return new Response(JSON.stringify({ event_id: "$sent" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const sent = await sendMessage(client, "!room:localhost", "to everyone");

    expect(sent.id).toBe("$sent");
    expect(calls.some((c) => c.url.includes("/event/"))).toBe(false);
    const send = calls.find((c) => c.url.includes("/send/m.room.message/"));
    const payload = JSON.parse(send!.body!);
    expect(payload).toEqual({ msgtype: "m.text", body: "to everyone" });
  });
});

describe("stripQuote", () => {
  test("removes agent-generated quote prefix when replying", () => {
    const input = `> <@agora-devon-elbs1:localhost>
> original message

My reply text`;
    const result = stripQuote(input);
    expect(result).toBe("My reply text");
  });

  test("handles quoted lines with various content", () => {
    const input = `> <@user:host>
> first line of original
> second line of original

And here's my response`;
    const result = stripQuote(input);
    expect(result).toBe("And here's my response");
  });

  test("handles quoted lines ending with blank line", () => {
    const input = `> <@user:host>
> original text
>

My response`;
    const result = stripQuote(input);
    expect(result).toBe("My response");
  });

  test("leaves non-quoted messages unchanged", () => {
    const input = "Just a regular message with no quote";
    const result = stripQuote(input);
    expect(result).toBe(input);
  });

  test("handles malformed input gracefully", () => {
    const input = "> <@incomplete";
    const result = stripQuote(input);
    expect(result).toBe(input); // No match, return original
  });
});

