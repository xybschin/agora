import { afterEach, describe, expect, test } from "bun:test";

// The runner creates the room each Run happens in (ADR-0003), and
// matrixBootstrap.ts needs the same create/invite/join calls before that, so
// both share this module. The module that holds them must be importable without
// doing anything: if importing it registered an account or created a room,
// merely starting the runner would mutate the homeserver. It also owns the
// Client-Server path prefix, so the wrong version segment fails here rather than
// as a 404 from a homeserver.

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

/** Replaces global fetch with a recorder, so we can see every homeserver call. */
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
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  }) as FetchFn;
  globalThis.fetch = recorder;
  restore.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

// Imported dynamically, not statically, so this is the first (uncached)
// evaluation of the module and the call count below really is import-time
// work rather than an already-evaluated module being handed back.
describe("importing matrixRooms", () => {
  test("registers nothing and creates no room", async () => {
    const calls = recordFetch();
    const rooms = await import("./matrixRooms.js");
    // Proof the import actually evaluated the module rather than resolving
    // to nothing, so the empty call list below means "did nothing".
    expect(typeof rooms.createRoom).toBe("function");
    expect(calls).toEqual([]);
  });
});

describe("clientPath", () => {
  // Spelling the prefix in one place only pays off if that one place is itself
  // pinned to the path a homeserver actually serves. Comparing the builder
  // against itself would agree with any prefix at all, so the expected values
  // below are written out in full.
  test("prefixes an endpoint with the versioned Client-Server path", async () => {
    const { clientPath } = await import("./matrixRooms.js");

    expect(clientPath("createRoom")).toBe("/_matrix/client/v3/createRoom");
    expect(clientPath("rooms/!room%3Alocalhost/invite")).toBe(
      "/_matrix/client/v3/rooms/!room%3Alocalhost/invite",
    );
  });

  test("joins the prefix and the endpoint with exactly one slash", async () => {
    const { clientPath } = await import("./matrixRooms.js");

    // An empty suffix is the prefix itself, with no slash of its own to swallow:
    // it is what a caller trimming a recorded urlPath back to its endpoint
    // compares against.
    expect(clientPath("")).toBe("/_matrix/client/v3");
    expect(clientPath("register")).toBe("/_matrix/client/v3/register");
  });
});

describe("roomPath", () => {
  // The room segment is the second half of the same single-sourcing bargain
  // `clientPath` made for the version prefix, and the expected paths are written
  // out in full for the same reason: a builder checked against itself would
  // agree with any segment or any escaping at all.
  test("puts the room under the Client-Server prefix and escapes its id", async () => {
    const { roomPath } = await import("./matrixRooms.js");

    // `:` does not strictly need escaping inside a path segment, but the runner
    // has always sent it escaped and a homeserver is entitled to be strict
    // about what it accepts, so the escaped form is the one pinned here -- and
    // the invite, join and send assertions below all spell the same thing.
    expect(roomPath("!room:localhost", "invite")).toBe(
      "/_matrix/client/v3/rooms/!room%3Alocalhost/invite",
    );
  });

  test("escapes an id whose characters would otherwise change the path", async () => {
    const { roomPath } = await import("./matrixRooms.js");

    // No homeserver hands out a room id like this, which is the point: the test
    // is about the contract (this function escapes, a caller need not) rather
    // than about a realistic id. A raw `/` or `?` would name a different endpoint
    // or start a query string, and only a live 404 would say so mid-Run.
    expect(roomPath("!we/ird?room:localhost", "join")).toBe(
      "/_matrix/client/v3/rooms/!we%2Fird%3Froom%3Alocalhost/join",
    );
  });

  test("adds no trailing slash of its own, and eats none a caller appended", async () => {
    const { roomPath } = await import("./matrixRooms.js");

    // The power levels write and its read-back are two forms of one endpoint,
    // differing only in the state key, and the empty key the write names is a
    // trailing slash. So this neither supplies one nor normalises one away, and
    // the caller keeps the distinction rather than handing it to the builder.
    expect(roomPath("!room:localhost", "state/m.room.power_levels")).toBe(
      "/_matrix/client/v3/rooms/!room%3Alocalhost/state/m.room.power_levels",
    );
    expect(roomPath("!room:localhost", "state/m.room.power_levels/")).toBe(
      "/_matrix/client/v3/rooms/!room%3Alocalhost/state/m.room.power_levels/",
    );
  });
});

describe("createRoom", () => {
  test("creates a public room as the setup user and returns its id", async () => {
    const calls = recordFetch(
      () => new Response(JSON.stringify({ room_id: "!room:localhost" })),
    );
    const { createRoom } = await import("./matrixRooms.js");

    const roomId = await createRoom(
      "http://localhost:8008",
      "syt_setup",
      "Agora - remote-work-policy",
    );

    expect(roomId).toBe("!room:localhost");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://localhost:8008/_matrix/client/v3/createRoom",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe("Bearer syt_setup");
    expect(calls[0]?.body).toEqual({
      name: "Agora - remote-work-policy",
      preset: "public_chat",
      visibility: "public",
    });
  });
});

describe("inviteUserToRoom", () => {
  test("invites the user id into the room as the setup user", async () => {
    const calls = recordFetch(() => new Response("{}"));
    const { inviteUserToRoom } = await import("./matrixRooms.js");

    await inviteUserToRoom(
      "http://localhost:8008",
      "syt_setup",
      "!room:localhost",
      "@agora-alex:localhost",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://localhost:8008/_matrix/client/v3/rooms/!room%3Alocalhost/invite",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe("Bearer syt_setup");
    expect(calls[0]?.body).toEqual({ user_id: "@agora-alex:localhost" });
  });
});

describe("joinRoom", () => {
  test("joins with the joining user's own token, not the setup user's", async () => {
    const calls = recordFetch(() => new Response("{}"));
    const { joinRoom } = await import("./matrixRooms.js");

    await joinRoom(
      "http://localhost:8008",
      "syt_alex",
      "!room:localhost",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://localhost:8008/_matrix/client/v3/rooms/!room%3Alocalhost/join",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe("Bearer syt_alex");
  });
});

describe("csRequest", () => {
  test("reports the failing call and the homeserver's text", async () => {
    recordFetch(
      () => new Response("M_FORBIDDEN: not in this room", { status: 403 }),
    );
    const { csRequest } = await import("./matrixRooms.js");

    await expect(
      csRequest("http://localhost:8008", "POST", "/_matrix/client/v3/join", {
        accessToken: "syt_alex",
      }),
    ).rejects.toThrow(
      "POST /_matrix/client/v3/join -> HTTP 403: M_FORBIDDEN: not in this room",
    );
  });

  test("waits out a rate limit and re-sends the request", async () => {
    // A homeserver is entitled to answer 429, and the Client-Server API asks
    // clients to honour retry_after_ms. The first live Run failed on it: six
    // invites fired back to back, the limiter answered 429 mid-sequence, and
    // the Run died. A Run that skips an invite is not a Run that should be
    // salvaged by crashing.
    let attempt = 0;
    const calls = recordFetch(() => {
      attempt += 1;
      return attempt < 3
        ? new Response(
            JSON.stringify({
              errcode: "M_LIMIT_EXCEEDED",
              error: "Too Many Requests",
              retry_after_ms: 1,
            }),
            { status: 429 },
          )
        : new Response(JSON.stringify({ event_id: "$invite" }));
    });
    const { csRequest } = await import("./matrixRooms.js");

    const result = await csRequest(
      "http://localhost:8008",
      "POST",
      "/_matrix/client/v3/rooms/!r:localhost/invite",
      { accessToken: "syt_setup", body: { user_id: "@agora-alex:localhost" } },
    );

    expect(result).toEqual({ event_id: "$invite" });
    // Re-sent until it was accepted, and re-sent with the same body and the
    // same token -- a retry that changed either would be a different request.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.body).toEqual({ user_id: "@agora-alex:localhost" });
      expect(call.authorization).toBe("Bearer syt_setup");
    }
  });

  test("gives up on a rate limit rather than retrying forever", async () => {
    const calls = recordFetch(
      () =>
        new Response(
          JSON.stringify({
            errcode: "M_LIMIT_EXCEEDED",
            retry_after_ms: 1,
          }),
          { status: 429 },
        ),
    );
    const { csRequest } = await import("./matrixRooms.js");

    // A homeserver that rate limits indefinitely is a real failure, and the
    // Run has to be told so rather than hanging on a retry loop.
    await expect(
      csRequest("http://localhost:8008", "POST", "/_matrix/client/v3/join", {
        accessToken: "syt_alex",
      }),
    ).rejects.toThrow("HTTP 429");

    expect(calls.length).toBeGreaterThan(1);
  });

  test("waits out a rate limit even when the body carries no retry_after_ms", async () => {
    let attempt = 0;
    recordFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("not even json", { status: 429 })
        : new Response(JSON.stringify({ ok: true }));
    });
    const { csRequest } = await import("./matrixRooms.js");

    // The fallback has to be a real wait. Retrying instantly is the thing the
    // 429 was warning against, so an unparseable body waits rather than spins.
    const started = Date.now();
    const result = await csRequest(
      "http://localhost:8008",
      "GET",
      "/_matrix/client/v3/account/whoami",
    );

    expect(result).toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
