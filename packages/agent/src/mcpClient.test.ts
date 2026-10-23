/**
 * Pins the room client's own behaviour: every model-facing catalog tool maps to
 * a room operation, the specs it advertises follow from that map, and tool
 * results become typed outcomes. The runtimes are tested against a stub, so
 * this is the only place the parsing and the catalog wiring are exercised.
 */
import { describe, expect, test } from "bun:test";
import { matrixToolCatalog, matrixWaitForActivityTool } from "@agora/shared";
import { MatrixMcpClient, roomToolKind } from "./mcpClient.js";

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/** A client whose transport answers with `result`, recording every call. */
function clientAnsweredBy(
  result: string | ((name: string, args: Record<string, unknown>) => string | Promise<string>),
): { client: MatrixMcpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = new MatrixMcpClient("http://unused", "token", async (name, args) => {
    calls.push({ name, args });
    return typeof result === "function" ? result(name, args) : result;
  });
  return { client, calls };
}

describe("tool-kind map", () => {
  test("maps every model-facing catalog tool and nothing else", () => {
    for (const { name } of matrixToolCatalog) {
      if (name === matrixWaitForActivityTool) {
        // Runtime-only: the model must never be offered a blocking wait.
        expect(roomToolKind(name)).toBeUndefined();
      } else {
        expect(roomToolKind(name)).toBeDefined();
      }
    }
    expect(roomToolKind("matrix_send_message")).toBeUndefined();
    expect(roomToolKind("classify_discussion")).toBeUndefined();
    // Model-supplied names can collide with Object.prototype's keys.
    expect(roomToolKind("constructor")).toBeUndefined();
    expect(roomToolKind("toString")).toBeUndefined();
  });
});

describe("listToolSpecs", () => {
  test("advertises the catalog minus the long-poll", () => {
    const { client } = clientAnsweredBy("[]");

    const names = client.listToolSpecs().map((spec) => spec.function.name);

    expect(names).toEqual([
      "matrix_read_room",
      "matrix_reply",
      "matrix_post",
      "matrix_add_reaction",
    ]);
  });

  test("withholds the kinds it is asked to exclude", () => {
    const { client } = clientAnsweredBy("[]");

    const names = client.listToolSpecs({ exclude: ["reply"] }).map((spec) => spec.function.name);

    expect(names).not.toContain("matrix_reply");
    expect(names).toContain("matrix_post");
  });

  test("derives each spec's parameters from the shared catalog schema", () => {
    const { client } = clientAnsweredBy("[]");
    const read = client.listToolSpecs().find((spec) => spec.function.name === "matrix_read_room");

    expect(read?.function.parameters).toMatchObject({ type: "object" });
    expect(read?.function.description).toContain("Read recent messages");
  });
});

describe("room operations", () => {
  test("readRoom returns the typed messages, oldest first", async () => {
    const messages = [
      { eventId: "$a", sender: "@a:x", senderDisplayName: "A", content: "first", createdAt: "t1" },
      { eventId: "$b", sender: "@b:x", senderDisplayName: "B", content: "second", createdAt: "t2" },
    ];
    const { client, calls } = clientAnsweredBy(JSON.stringify(messages));

    await expect(client.readRoom()).resolves.toEqual(messages);
    expect(calls).toEqual([{ name: "matrix_read_room", args: { limit: 20 } }]);
  });

  test("readRoom clamps a model-supplied limit to the schema's range", async () => {
    for (const [limit, expected] of [
      [1, 1],
      [0, 1],
      [-4, 1],
      [250, 100],
      [5.9, 5],
      [Number.NaN, 20],
    ] as const) {
      const { client, calls } = clientAnsweredBy("[]");
      await client.readRoom(limit);
      expect(calls[0]!.args.limit).toBe(expected);
    }
  });

  test("readRoom throws when the result is not a message list", async () => {
    const { client } = clientAnsweredBy("not json");

    await expect(client.readRoom()).rejects.toThrow(/did not return a message list/);
  });

  test("readRoom propagates a transport failure", async () => {
    const { client } = clientAnsweredBy(() => {
      throw new Error("MCP tool call failed for matrix_read_room: refused");
    });

    await expect(client.readRoom()).rejects.toThrow(/MCP tool call failed/);
  });

  test("post reports a send with its envelope", async () => {
    const { client, calls } = clientAnsweredBy(
      JSON.stringify({ id: "$sent", createdAt: "2026-01-01T00:00:00Z" }),
    );

    await expect(client.post("hello")).resolves.toEqual({
      kind: "sent",
      message: { id: "$sent", createdAt: "2026-01-01T00:00:00Z" },
    });
    expect(calls).toEqual([{ name: "matrix_post", args: { content: "hello" } }]);
  });

  test("post reports an accepted send it could not read without throwing", async () => {
    // The room kept the message; the Turn must still count it as posted.
    for (const raw of ["not json", "null", JSON.stringify({ id: "$sent" })]) {
      const { client } = clientAnsweredBy(raw);
      await expect(client.post("hello")).resolves.toEqual({ kind: "unreadable", raw });
    }
  });

  test("reply reports the server's refusal as a rejection, not an error", async () => {
    const { client, calls } = clientAnsweredBy(
      JSON.stringify({ rejected: "cannot reply to your own message" }),
    );

    await expect(client.reply("$mine", "hello")).resolves.toEqual({
      kind: "rejected",
      reason: "cannot reply to your own message",
    });
    expect(calls).toEqual([
      { name: "matrix_reply", args: { eventId: "$mine", content: "hello" } },
    ]);
  });

  test("reply reports a send with its envelope", async () => {
    const { client } = clientAnsweredBy(
      JSON.stringify({ id: "$reply", createdAt: "2026-01-01T00:00:00Z" }),
    );

    await expect(client.reply("$target", "hi")).resolves.toEqual({
      kind: "sent",
      message: { id: "$reply", createdAt: "2026-01-01T00:00:00Z" },
    });
  });

  test("reply reports an unreadable send", async () => {
    const { client } = clientAnsweredBy("garbage");

    await expect(client.reply("$target", "hi")).resolves.toEqual({
      kind: "unreadable",
      raw: "garbage",
    });
  });

  test("addReaction passes the target and emoji through", async () => {
    const { client, calls } = clientAnsweredBy("ok");

    await expect(client.addReaction("$target", "👍")).resolves.toEqual({ kind: "done" });
    expect(calls).toEqual([
      { name: "matrix_add_reaction", args: { eventId: "$target", reaction: "👍" } },
    ]);
  });

  test("addReaction returns a tool-level error instead of reporting success", async () => {
    const { client } = clientAnsweredBy("M_FORBIDDEN: cannot react to that event");

    await expect(client.addReaction("$target", "👍")).resolves.toEqual({
      kind: "failed",
      reason: "M_FORBIDDEN: cannot react to that event",
    });
  });

  test("waitForActivity returns the parsed poll result and passes the resume token", async () => {
    const { client, calls } = clientAnsweredBy(
      JSON.stringify({ hasActivity: true, nextBatch: "b2" }),
    );

    await expect(client.waitForActivity({ timeoutMs: 500, since: "b1" })).resolves.toEqual({
      hasActivity: true,
      nextBatch: "b2",
    });
    expect(calls).toEqual([
      { name: matrixWaitForActivityTool, args: { timeoutMs: 500, since: "b1" } },
    ]);
  });

  test("waitForActivity falls back to no activity when the envelope omits fields", async () => {
    const { client } = clientAnsweredBy("{}");

    await expect(client.waitForActivity({ timeoutMs: 500 })).resolves.toEqual({
      hasActivity: false,
      nextBatch: "",
    });
  });
});
