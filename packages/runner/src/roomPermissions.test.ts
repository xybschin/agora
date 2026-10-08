import { describe, expect, test } from "bun:test";
import { roomPermissionMismatches, runRoomPowerLevels } from "./roomPermissions.js";

// A Reader has to read a Run's whole conversation and yet be structurally
// unable to speak (ADR-0003). The room's power levels are the only thing that
// makes that structural, so these tests pin the exact levels rather than just
// the shape: an agent at the wrong number either cannot talk (the Run is dead)
// or can rewrite the power levels (the whole guarantee is gone).

const wanted = runRoomPowerLevels({
  agentUserIds: ["@agora-alex:localhost", "@agora-bri:localhost"],
});

describe("runRoomPowerLevels", () => {
  test("seats the agents above the room's default event threshold", () => {
    // The agents have to be able to send m.room.message and m.reaction, which
    // fall to events_default because neither is named in `events`.
    expect(wanted.events_default).toBe(50);
    expect(wanted.events["m.room.message"]).toBeUndefined();
    expect(wanted.events["m.reaction"]).toBeUndefined();
    expect(wanted.users["@agora-alex:localhost"]).toBeGreaterThanOrEqual(
      wanted.events_default,
    );
    expect(wanted.users["@agora-bri:localhost"]).toBeGreaterThanOrEqual(
      wanted.events_default,
    );
  });

  test("leaves a Reader at the default level, so it can neither message nor react", () => {
    expect(wanted.users_default).toBe(0);
    // A Reader is in users_default by not being in `users` at all: nothing in
    // the invite path puts a Reader there.
    expect(Object.values(wanted.users)).not.toContain(0);
    expect(wanted.users_default).toBeLessThan(wanted.events_default);
  });

  test("raises invite, kick, ban and redact above the agents", () => {
    for (const level of [
      wanted.invite,
      wanted.kick,
      wanted.ban,
      wanted.redact,
    ]) {
      expect(level).toBeGreaterThan(50);
    }
  });

  test("raises every state event above the agents, so an agent cannot escalate itself", () => {
    // state_default covers state events nobody thought to name, which is what
    // stops an agent from rewriting the power levels and handing itself 100;
    // naming the room's metadata events makes that readable rather than implied.
    expect(wanted.state_default).toBeGreaterThan(50);
    for (const eventType of [
      "m.room.power_levels",
      "m.room.name",
      "m.room.topic",
      "m.room.avatar",
      "m.room.canonical_alias",
      "m.room.history_visibility",
      "m.room.encryption",
      "m.room.tombstone",
      "m.room.server_acl",
    ]) {
      expect(wanted.events[eventType]).toBeGreaterThan(50);
    }
  });

  test("does not seat the setup account in users, leaving its 100 to the creator rule", () => {
    // The setup account owns the room as its creator, and Synapse refuses a
    // power-levels event whose `users` names the creator ("Creator user ... must
    // not appear in content.users") because a creator's 100 is immutable and not
    // an event entry. A live Run died on exactly that 400. So the
    // owner's 100 is the homeserver's creator rule, and the written event names
    // it nowhere — which is what this pins down.
    expect(Object.keys(wanted.users)).not.toContain("@agora-setup:localhost");
    // Every `users` entry is an agent, and all of them sit at the level that
    // clears `events_default`.
    for (const level of Object.values(wanted.users)) {
      expect(level).toBe(wanted.events_default);
      expect(level).toBeGreaterThan(wanted.users_default);
    }
  });
});

describe("roomPermissionMismatches", () => {
  test("finds nothing when the homeserver stored exactly what was asked for", () => {
    expect(roomPermissionMismatches(wanted, wanted)).toEqual([]);
  });

  test("accepts defaults the homeserver added on its own", () => {
    // Compare the keys we set, not the whole object: a homeserver is entitled
    // to fill in keys we never sent (notifications, ban/kick defaults it
    // prefers), and that is not the Run failing to get what it asked for.
    expect(
      roomPermissionMismatches(wanted, {
        ...wanted,
        notifications: { room: 50 },
      }),
    ).toEqual([]);
  });

  test("reports a threshold that moved, because a Reader could then post", () => {
    const mismatches = roomPermissionMismatches(wanted, {
      ...wanted,
      events_default: 0,
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("events_default");
    expect(mismatches[0]).toContain("0");
  });

  test("reports an agent that is missing from the users map", () => {
    const { "@agora-bri:localhost": _bri, ...rest } = wanted.users;
    const mismatches = roomPermissionMismatches(wanted, {
      ...wanted,
      users: rest,
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("users.@agora-bri:localhost");
  });

  test("reports an event type that came back unpinned", () => {
    const mismatches = roomPermissionMismatches(wanted, {
      ...wanted,
      events: { ...wanted.events, "m.room.power_levels": 50 },
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("events.m.room.power_levels");
  });

  test("reports a state event that is not a power levels event at all", () => {
    expect(roomPermissionMismatches(wanted, undefined)).not.toEqual([]);
    expect(roomPermissionMismatches(wanted, null)).not.toEqual([]);
    expect(roomPermissionMismatches(wanted, "nope")).not.toEqual([]);
  });
});
