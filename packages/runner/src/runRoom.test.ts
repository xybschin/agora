import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { createRunRoom, roomNameForRun } from "./runRoom.js";
import { clientPath } from "./matrixRooms.js";

// A Run gets its own room (ADR-0003), so the room is not a credentials-file
// value any more: the runner creates it, admits the Scenario's agents, pins its
// permissions, and hands the resulting id on. That lifecycle is what these tests
// pin down -- the room's name, the create-then-admit-then-pin ordering, the
// exact power levels written and read back, and the Readers the Scenario
// declares being invited last, into a room whose permissions are already known.
// The fact that a second Run of the same Scenario lands in a different room with
// nothing of the first Run's history in it.

interface FetchCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

interface HomeserverStub {
  readBackPowerLevels?: unknown;
}

const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
});

/**
 * Stands in for the homeserver. createRoom hands back a fresh room id per call,
 * so two Runs in one test really do get two different rooms rather than the same
 * stubbed value twice, and a PUT state event is remembered so the GET that reads
 * it back answers with what was actually written.
 */
function stubHomeserver(stub: HomeserverStub = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const state = new Map<string, unknown>();
  let roomsCreated = 0;
  const original = globalThis.fetch;
  type FetchFn = typeof globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({
      url,
      method: init?.method,
      authorization: headers["Authorization"],
      body,
    });
    if (url.endsWith("/createRoom")) {
      roomsCreated += 1;
      return new Response(JSON.stringify({ room_id: `!run${roomsCreated}:localhost` }));
    }
    if (url.includes("/state/m.room.power_levels")) {
      if (init?.method === "PUT") {
        state.set("m.room.power_levels", body);
        return new Response(JSON.stringify({ event_id: "$powerlevels" }));
      }
      // The bare content, not an envelope. GET .../state/m.room.power_levels
      // answers with the state event's content on its own -- there is no
      // `content` wrapper on this endpoint. This stub used to add one, which
      // agreed with the caller instead of with the homeserver and so let a
      // read-back that could never succeed against a real Synapse pass here.
      return new Response(
        JSON.stringify(
          stub.readBackPowerLevels ?? state.get("m.room.power_levels") ?? {},
        ),
      );
    }
    return new Response("{}");
  }) as FetchFn;
  restore.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** The exact power levels the runner writes, spelled out rather than recomputed. */
const expectedPowerLevels = {
  users: {
    "@agora-alex:localhost": 50,
    "@agora-bri:localhost": 50,
  },
  users_default: 0,
  events: {
    "m.room.power_levels": 100,
    "m.room.name": 100,
    "m.room.topic": 100,
    "m.room.avatar": 100,
    "m.room.canonical_alias": 100,
    "m.room.history_visibility": 100,
    "m.room.encryption": 100,
    "m.room.tombstone": 100,
    "m.room.server_acl": 100,
  },
  events_default: 50,
  state_default: 100,
  invite: 100,
  kick: 100,
  ban: 100,
  redact: 100,
};

const POWER_LEVELS_STATE = "state/m.room.power_levels";
const ROOM = "!run1%3Alocalhost";
const HOMESERVER = "http://localhost:8008";
// Derived from the production seam rather than written out again, so the
// assertions below can read as endpoints (`POST /createRoom`) without this file
// holding a second copy of the version prefix to drift.
const CLIENT_PREFIX = HOMESERVER + clientPath("");

function invitesTo(calls: FetchCall[]): unknown[] {
  return calls.filter((call) => call.url.endsWith("/invite")).map((call) => call.body);
}

/** Index of the invite for one user id, or -1 if that user was never invited. */
function inviteIndexFor(calls: FetchCall[], userId: string): number {
  return calls.findIndex(
    (call) =>
      call.url.endsWith("/invite") &&
      (call.body as { user_id?: string }).user_id === userId,
  );
}

function powerLevelsCall(calls: FetchCall[], method: string): number {
  return calls.findIndex(
    (call) => call.method === method && call.url.includes(POWER_LEVELS_STATE),
  );
}

function scenarioWith(agentIds: string[], observers?: string[]): ScenarioConfig {
  return {
    name: "remote-work-policy",
    topic: "Should remote work stay optional?",
    seedMessage: "The floor is yours.",
    maxRuntimeMs: 120000,
    maxToolStepsPerTurn: 6,
    budget: {},
    ...(observers ? { observers } : {}),
    agents: agentIds.map((id) => ({
      id,
      persona: {
        displayName: id,
        flavorText: "",
        traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
        initialStance: 0,
      },
    })),
  };
}

function credentialsFor(agentIds: string[]): CredentialsFile {
  return {
    matrixSetupAccessToken: "syt_setup",
    matrixSetupUserId: "@agora-setup:localhost",
    matrix: {
      hostBaseUrl: HOMESERVER,
      containerBaseUrl: "http://synapse:8008",
    },
    agents: Object.fromEntries(
      agentIds.map((id) => [
        id,
        {
          matrixAccessToken: `syt_${id}`,
          matrixUserId: `@agora-${id}:localhost`,
          llmBaseUrl: "https://example.com/v1",
          llmApiKey: "sk-test",
          llmModel: "deepseek-v4-flash-sovereign",
        },
      ]),
    ),
  };
}

describe("roomNameForRun", () => {
  test("names a room for its Scenario and its runId, so a Reader can tell rooms apart", () => {
    expect(roomNameForRun("remote-work-policy", "remote-work-policy-20251001-1420")).toBe(
      "Agora - remote-work-policy - remote-work-policy-20251001-1420",
    );
  });

  test("gives two Runs of the same Scenario two different names", () => {
    const first = roomNameForRun("remote-work-policy", "remote-work-policy-20251001-1420");
    const second = roomNameForRun("remote-work-policy", "remote-work-policy-20251001-1500");
    expect(first).not.toBe(second);
  });
});

describe("createRunRoom", () => {
  test("creates the room as the setup user, then admits every agent, then pins its permissions", async () => {
    const calls = stubHomeserver();
    const scenario = scenarioWith(["alex", "bri"]);

    const roomId = await createRunRoom({
      scenario,
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    expect(roomId).toBe("!run1:localhost");
    expect(calls.map((call) => `${call.method} ${call.url.replace(CLIENT_PREFIX, "")}`)).toEqual([
      "POST /createRoom",
      `PUT /profile/%40agora-setup%3Alocalhost/displayname`, // Set setup account display name to "Moderator"
      `POST /rooms/${ROOM}/join`, // Setup account joins as Moderator
      `POST /rooms/${ROOM}/invite`,
      `POST /rooms/${ROOM}/join`,
      `POST /rooms/${ROOM}/invite`,
      `POST /rooms/${ROOM}/join`,
      `PUT /rooms/${ROOM}/${POWER_LEVELS_STATE}/`,
      `GET /rooms/${ROOM}/${POWER_LEVELS_STATE}`,
    ]);
    // The room is created as the setup account, which is also the account that
    // sends the invites; only the join happens as the agent itself.
    expect(calls[0]?.authorization).toBe("Bearer syt_setup");
    expect(calls[0]?.body).toEqual({
      name: "Agora - remote-work-policy - remote-work-policy-20251001-1420",
      preset: "public_chat",
      visibility: "public",
    });
    expect(calls[1]?.authorization).toBe("Bearer syt_setup");
    expect(calls[1]?.body).toEqual({ displayname: "Moderator" });
    expect(calls[2]?.authorization).toBe("Bearer syt_setup");
    expect(calls[3]?.authorization).toBe("Bearer syt_setup");
    expect(calls[3]?.body).toEqual({ user_id: "@agora-alex:localhost" });
    expect(calls[4]?.authorization).toBe("Bearer syt_alex");
    expect(calls[5]?.body).toEqual({ user_id: "@agora-bri:localhost" });
    expect(calls[6]?.authorization).toBe("Bearer syt_bri");
  });

  test("writes the power levels that leave a Reader readable but unable to speak", async () => {
    const calls = stubHomeserver();

    await createRunRoom({
      scenario: scenarioWith(["alex", "bri"]),
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    const put = powerLevelsCall(calls, "PUT");
    // Spelled out here rather than recomputed from the builder, so the literal
    // the runner puts on the wire is what this pins down.
    expect(calls[put]?.body).toEqual(expectedPowerLevels);
    // Written as the setup account, which owns the room and is the only account
    // above the agents.
    expect(calls[put]?.authorization).toBe("Bearer syt_setup");
  });

  test("reads the power levels back after writing them", async () => {
    const calls = stubHomeserver();

    await createRunRoom({
      scenario: scenarioWith(["alex", "bri"]),
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    const readBack = calls.filter(
      (call) => call.method === "GET" && call.url.includes(POWER_LEVELS_STATE),
    );
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.authorization).toBe("Bearer syt_setup");
    expect(readBack[0]?.body).toBeUndefined();
    // The read comes after the write, or it proves nothing.
    expect(powerLevelsCall(calls, "GET")).toBeGreaterThan(
      powerLevelsCall(calls, "PUT"),
    );
  });

  test("treats the read-back as the state event's bare content, not an envelope", async () => {
    // Pinned because getting it wrong is silent until a real Run aborts. The
    // first live Run failed here: this call site read `.content` off the
    // response, but GET /rooms/{id}/state/m.room.power_levels answers with the
    // state event's content on its own, so `.content` was undefined and every
    // Run refused itself at tick 0. The stub had been answering with a
    // `content` wrapper, so it agreed with the call site rather than with the
    // API and the whole suite stayed green.
    //
    // So: a homeserver that answers with the bare content must be accepted.
    const calls = stubHomeserver();

    await createRunRoom({
      scenario: scenarioWith(["alex", "bri"]),
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    // It got past the read-back, which is the whole assertion: no
    // RoomPermissionsError, so the bare shape was understood. And a wrapped
    // response would still be caught, because an envelope has no `users` map at
    // its top level.
    expect(powerLevelsCall(calls, "GET")).toBeGreaterThan(-1);
  });

  test("refuses the Run when the power levels read back are not the ones it asked for", async () => {
    const calls = stubHomeserver({
      readBackPowerLevels: {
        ...expectedPowerLevels,
        // The homeserver stored a threshold a Reader clears, so the very
        // guarantee this room exists for is gone.
        events_default: 0,
      },
    });

    await expect(
      createRunRoom({
        scenario: scenarioWith(["alex", "bri"], ["@bjarse:localhost"]),
        credentials: credentialsFor(["alex", "bri"]),
        runId: "remote-work-policy-20251001-1420",
      }),
    ).rejects.toThrow("events_default");

    // The agents are already in by then -- they have to be, their levels are
    // part of what gets written -- but no Reader was: nobody human is admitted
    // to a room whose permissions are not what the Run asked for.
    expect(inviteIndexFor(calls, "@bjarse:localhost")).toBe(-1);
  });

  test("invites each declared Reader into the room, by user id and with no token", async () => {
    const calls = stubHomeserver();

    const roomId = await createRunRoom({
      scenario: scenarioWith(["alex", "bri"], [
        "@bjarse:localhost",
        "@domain-expert:matrix.example.org",
      ]),
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    expect(invitesTo(calls)).toEqual([
      { user_id: "@agora-alex:localhost" },
      { user_id: "@agora-bri:localhost" },
      { user_id: "@bjarse:localhost" },
      { user_id: "@domain-expert:matrix.example.org" },
    ]);
    // Readers are invited last, so a Reader is never admitted to a room whose
    // permissions have not been read back yet, and the invite is sent by the
    // setup account rather than by the Reader.
    const readerInvite = inviteIndexFor(calls, "@bjarse:localhost");
    expect(readerInvite).toBeGreaterThan(powerLevelsCall(calls, "PUT"));
    expect(calls[readerInvite]?.authorization).toBe("Bearer syt_setup");

    // No Reader was ever joined, and no homeserver call carries a token that is
    // not the setup account's or an agent's -- because no Reader token exists to
    // carry. Everything the runner does is done with credentials it holds.
    expect(new Set(calls.map((call) => call.authorization))).toEqual(
      new Set(["Bearer syt_setup", "Bearer syt_alex", "Bearer syt_bri"]),
    );
    expect(roomId).toBe("!run1:localhost");
  });

  test("a Scenario that declares no Readers is admitted exactly as before", async () => {
    const calls = stubHomeserver();

    await createRunRoom({
      scenario: scenarioWith(["alex", "bri"]),
      credentials: credentialsFor(["alex", "bri"]),
      runId: "remote-work-policy-20251001-1420",
    });

    // Only the agents are invited, and the room carries the same permissions in
    // either case: pinning them is what makes a declared Reader safe, and it
    // costs an agent nothing.
    expect(invitesTo(calls)).toEqual([
      { user_id: "@agora-alex:localhost" },
      { user_id: "@agora-bri:localhost" },
    ]);
  });

  test("a second Run of the same Scenario gets a different room, and admits only into that one", async () => {
    const calls = stubHomeserver();
    const scenario = scenarioWith(["alex", "bri"]);
    const credentials = credentialsFor(["alex", "bri"]);

    const firstRoomId = await createRunRoom({
      scenario,
      credentials,
      runId: "remote-work-policy-20251001-1420",
    });
    const secondRoomId = await createRunRoom({
      scenario,
      credentials,
      runId: "remote-work-policy-20251001-1500",
    });

    expect(secondRoomId).not.toBe(firstRoomId);

    // The first Run's room is created and populated before the second Run
    // starts; nothing the second Run does reaches back into it, so an agent in
    // the second Run cannot read the first Run's Transcript. Its createRoom call
    // is the only second-Run call that doesn't name a room.
    // First run now has 9 calls (was 7, but now includes setDisplayName + setup join).
    // The second run starts at index 9, so there should be 9 more calls after the first.
    const secondRunStartIndex = 9;
    const secondRunCalls = calls.slice(secondRunStartIndex);
    expect(secondRunCalls.length).toBe(9);
    expect(
      secondRunCalls
        .slice(2) // Skip the createRoom and setDisplayName, which don't address the room
        .every((call) => call.url.includes("!run2%3Alocalhost")),
    ).toBe(true);
    expect(calls[secondRunStartIndex]?.body).toEqual({
      name: "Agora - remote-work-policy - remote-work-policy-20251001-1500",
      preset: "public_chat",
      visibility: "public",
    });
  });

  test("refuses to admit an agent with no credentials entry rather than half-populating the room", async () => {
    stubHomeserver();
    const scenario = scenarioWith(["alex", "bri"]);
    // Credentials for alex only: admitting the room's members is what proves the
    // Scenario can run, so a gap in the roster is a hard error.
    await expect(
      createRunRoom({
        scenario,
        credentials: credentialsFor(["alex"]),
        runId: "remote-work-policy-20251001-1420",
      }),
    ).rejects.toThrow('agent "bri"');
  });
});
