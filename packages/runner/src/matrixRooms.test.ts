import { afterEach, describe, expect, test } from "bun:test";

// The runner creates the room each Run happens in (ADR-0003), and
// matrixBootstrap.ts registers accounts through the same request seam and path
// builder, so both share this module. The module must be importable without
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
    // the Run died. Skipping the invite would leave an agent outside the room,
    // so the only acceptable answer is to wait as asked and re-send.
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

describe("deleteRoom", () => {
  // No Client-Server endpoint deletes a room; Synapse does it through its admin
  // API, which needs a server-admin token and purges in the background
  // (ADR-0009). The delete is only done once the purge reports complete.
  test("purges through the Synapse admin API with the admin token, then waits for completion", async () => {
    const { deleteRoom } = await import("./matrixRooms.js");
    let polls = 0;
    const calls = recordFetch((call) => {
      if (call.method === "DELETE") {
        return new Response(JSON.stringify({ delete_id: "del1" }));
      }
      polls += 1;
      const status = polls < 2 ? "active" : "complete";
      return new Response(JSON.stringify({ delete_id: "del1", status }));
    });

    await deleteRoom("https://hs", "syt_admin", "!room:localhost", { pollIntervalMs: 0 });

    expect(calls[0]).toEqual({
      url: "https://hs/_synapse/admin/v2/rooms/!room%3Alocalhost",
      method: "DELETE",
      authorization: "Bearer syt_admin",
      body: { purge: true },
    });
    const statusCalls = calls.slice(1);
    expect(statusCalls.length).toBe(2);
    for (const call of statusCalls) {
      expect(call.url).toBe("https://hs/_synapse/admin/v2/rooms/delete_status/del1");
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe("Bearer syt_admin");
    }
  });

  test("fails when the purge reports failed, naming the homeserver's error", async () => {
    const { deleteRoom } = await import("./matrixRooms.js");
    recordFetch((call) =>
      call.method === "DELETE"
        ? new Response(JSON.stringify({ delete_id: "del2" }))
        : new Response(JSON.stringify({ status: "failed", error: "boom" })),
    );

    await expect(
      deleteRoom("https://hs", "syt_admin", "!room:localhost", { pollIntervalMs: 0 }),
    ).rejects.toThrow(/boom/);
  });

  test("fails rather than waiting forever when the purge never completes", async () => {
    const { deleteRoom } = await import("./matrixRooms.js");
    recordFetch((call) =>
      call.method === "DELETE"
        ? new Response(JSON.stringify({ delete_id: "del3" }))
        : new Response(JSON.stringify({ status: "active" })),
    );

    await expect(
      deleteRoom("https://hs", "syt_admin", "!room:localhost", {
        pollIntervalMs: 0,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/did not complete/);
  });

  test("fails when the homeserver refuses the delete (e.g. the token is not an admin's)", async () => {
    const { deleteRoom } = await import("./matrixRooms.js");
    recordFetch(() => new Response('{"errcode":"M_FORBIDDEN"}', { status: 403 }));

    await expect(
      deleteRoom("https://hs", "syt_not_admin", "!room:localhost", { pollIntervalMs: 0 }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("registerAdminAccount", () => {
  // Synapse's shared-secret registration: fetch a nonce, then POST the account
  // with an HMAC-SHA1 over nonce, username, password and "admin", keyed by the
  // homeserver's registration_shared_secret. The expected MAC is computed here
  // independently from that definition.
  test("registers a server admin with an HMAC over the nonce and returns its token", async () => {
    const { createHmac } = await import("node:crypto");
    const { registerAdminAccount } = await import("./matrixRooms.js");
    const calls = recordFetch((call) =>
      call.method === "GET"
        ? new Response(JSON.stringify({ nonce: "n0nce" }))
        : new Response(
            JSON.stringify({ user_id: "@agora-admin:localhost", access_token: "syt_admin" }),
          ),
    );

    const account = await registerAdminAccount("https://hs", "s3cret", "agora-admin", "pw");

    expect(account).toEqual({ userId: "@agora-admin:localhost", accessToken: "syt_admin" });
    expect(calls[0]?.url).toBe("https://hs/_synapse/admin/v1/register");
    expect(calls[0]?.method).toBe("GET");
    const expectedMac = createHmac("sha1", "s3cret")
      .update("n0nce\0agora-admin\0pw\0admin")
      .digest("hex");
    expect(calls[1]).toEqual({
      url: "https://hs/_synapse/admin/v1/register",
      method: "POST",
      authorization: undefined,
      body: {
        nonce: "n0nce",
        username: "agora-admin",
        password: "pw",
        admin: true,
        mac: expectedMac,
      },
    });
  });
});

describe("findRoomIdByName", () => {
  // Run rooms are created with visibility "public", but Synapse need not
  // publish them to the room directory (the dev stack publishes none), so the
  // lookup searches Synapse's admin room list instead (ADR-0009).
  test("searches the admin room list by name and returns the exact match only", async () => {
    const { findRoomIdByName } = await import("./matrixRooms.js");
    const calls = recordFetch(() =>
      new Response(
        JSON.stringify({
          rooms: [
            { room_id: "!other:localhost", name: "Agora - s - s-20261008-0001 (copy)" },
            { room_id: "!run:localhost", name: "Agora - s - s-20261008-0001" },
          ],
          total_rooms: 2,
        }),
      ),
    );

    const roomId = await findRoomIdByName("https://hs", "syt_admin", "Agora - s - s-20261008-0001");

    expect(roomId).toBe("!run:localhost");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/_synapse/admin/v1/rooms");
    expect(url.searchParams.get("search_term")).toBe("Agora - s - s-20261008-0001");
    expect(calls[0]?.authorization).toBe("Bearer syt_admin");
  });

  test("follows next_batch and returns null when no room has the exact name", async () => {
    const { findRoomIdByName } = await import("./matrixRooms.js");
    const calls = recordFetch((call) =>
      new URL(call.url).searchParams.get("from") === null
        ? new Response(JSON.stringify({ rooms: [{ room_id: "!a:l", name: "x" }], next_batch: 1 }))
        : new Response(JSON.stringify({ rooms: [{ room_id: "!b:l", name: "y" }] })),
    );

    expect(await findRoomIdByName("https://hs", "syt_admin", "Agora - none")).toBeNull();
    expect(calls.length).toBe(2);
    expect(new URL(calls[1]!.url).searchParams.get("from")).toBe("1");
  });
});
