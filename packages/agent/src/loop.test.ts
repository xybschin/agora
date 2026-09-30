import { describe, expect, mock, test } from "bun:test";
import type { AgentDefinition } from "@agora/shared";
import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";

// loop.ts drives its tool loop through `chatCompletion` from ./llm.js, so to
// script what the model decides to do (which tool it calls, or whether it
// stops) that module is mocked here, before ./loop.js is imported. The mcp
// client is passed in as a plain stub, so matrix_send_message's success and
// failure paths are both reachable without a real homeserver.
//
// The mock replays a scripted list of assistant messages, one per
// chatCompletion call; a message with no tool_calls ends the tick.
type ScriptedMessage = ChatMessage & { tool_calls?: ToolCall[] };

let script: Array<ScriptedMessage> = [];

mock.module("./llm.js", () => ({
  chatCompletion: async () => {
    const next = script.shift();
    if (!next) throw new Error("test script exhausted: no more assistant messages");
    return { message: next, usage: { promptTokens: 5, completionTokens: 5 } };
  },
}));

const { AgentRuntime, buildTickMessage } = await import("./loop.js");
const { buildSystemPrompt } = await import("./persona.js");

const AGENT: AgentDefinition = {
  id: "alice",
  persona: {
    displayName: "Alice",
    flavorText: "Careful and measured.",
    traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
    initialStance: 0,
  },
};

function sendCall(content: string): ToolCall {
  return {
    id: `call_${content}`,
    type: "function",
    function: { name: "matrix_send_message", arguments: JSON.stringify({ content }) },
  };
}

function stanceCall(): ToolCall {
  return {
    id: "call_stance",
    type: "function",
    function: {
      name: "update_stance",
      arguments: JSON.stringify({ stance: 0, rationale: "no change" }),
    },
  };
}

function assistant(tool_calls?: ToolCall[]): ScriptedMessage {
  return { role: "assistant", content: tool_calls ? "thinking..." : "done", tool_calls };
}

// A module-level mcp stub whose callTool is swapped per test to simulate a
// successful matrix_send_message (a well-formed event envelope) or a hard
// failure. listToolSpecs returns no extra tools; the runtime adds stance itself.
const mcp: {
  listToolSpecs: () => Promise<ToolSpec[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
} = {
  listToolSpecs: async () => [],
  callTool: async () => {
    throw new Error("not reached");
  },
};

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return new AgentRuntime({
    runId: "scenario-test",
    agentId: "alice",
    agentDef: AGENT,
    topic: "Should the speed limit change?",
    roomId: "!room:localhost",
    matrixUserId: "@alice:localhost",
    maxToolStepsPerTick: 10,
    memoryWindowSize: 20,
    logDir: "/tmp/agora-loop-test",
    mcp: mcp as never,
    llm: { baseUrl: "http://test/v1", apiKey: "k", model: "m" },
    ...overrides,
  });
}

const OK_SEND = () => JSON.stringify({ id: "$evt", createdAt: "2026-01-01T00:00:00Z" });

describe("AgentRuntime own message history", () => {
  test("a successfully posted message is remembered in the queue", async () => {
    script = [assistant([sendCall("I think a 30 limit is right")]), assistant([stanceCall()]), assistant()];
    mcp.callTool = async (name: string) => (name === "matrix_send_message" ? OK_SEND() : "{}");

    const runtime = makeRuntime();
    await runtime.runTick(1, 5);

    expect(runtime.getOwnMessageHistory()).toEqual(["I think a 30 limit is right"]);
  });

  test("a failed send is not remembered as a commitment", async () => {
    script = [assistant([sendCall("this should not stick")]), assistant([stanceCall()]), assistant()];
    // Hard failure: the MCP call throws, so the send never completes and the
    // queue must not advance.
    mcp.callTool = async () => {
      throw new Error("homeserver rejected the message");
    };

    const runtime = makeRuntime();
    await expect(runtime.runTick(1, 5)).rejects.toThrow();
    expect(runtime.getOwnMessageHistory()).toEqual([]);
  });

  test("memory is isolated per agent", async () => {
    script = [assistant([sendCall("Alice posts")]), assistant([stanceCall()]), assistant()];
    mcp.callTool = async (name: string) => (name === "matrix_send_message" ? OK_SEND() : "{}");

    const alice = makeRuntime({ agentId: "alice", agentDef: { ...AGENT, id: "alice" } });
    const bob = makeRuntime({
      agentId: "bob",
      agentDef: { ...AGENT, id: "bob", persona: { ...AGENT.persona, displayName: "Bob" } },
    });

    // Only alice drives a tick; bob never posts and must not see her memory.
    await alice.runTick(1, 5);

    expect(alice.getOwnMessageHistory()).toEqual(["Alice posts"]);
    expect(bob.getOwnMessageHistory()).toEqual([]);
  });

  test("memory is isolated per run: each fresh runtime starts empty", async () => {
    script = [assistant([sendCall("run one post")]), assistant([stanceCall()]), assistant()];
    mcp.callTool = async (name: string) => (name === "matrix_send_message" ? OK_SEND() : "{}");

    // A new Run is a fresh agent container with its own runtime (per
    // architecture each Run's compose stack is brought up separately), so it
    // must begin with an empty queue even though an earlier Run posted.
    const run1 = makeRuntime({ runId: "scenario-20260101-0100" });
    await run1.runTick(1, 5);
    expect(run1.getOwnMessageHistory()).toHaveLength(1);

    const run2 = makeRuntime({ runId: "scenario-20260101-0200" });
    expect(run2.getOwnMessageHistory()).toEqual([]);
  });

  test("the queue is bounded to the most recent posts, dropping the oldest", async () => {
    // Post four messages in one tick; the queue must keep only the last three
    // and forget the first (which is still visible in room history if read).
    script = [
      assistant([sendCall("one"), sendCall("two"), sendCall("three"), sendCall("four")]),
      assistant([stanceCall()]),
      assistant(),
    ];
    mcp.callTool = async (name: string) => (name === "matrix_send_message" ? OK_SEND() : "{}");

    const runtime = makeRuntime();
    await runtime.runTick(1, 5);

    expect(runtime.getOwnMessageHistory()).toEqual(["two", "three", "four"]);
  });
});

describe("buildSystemPrompt own-message section", () => {
  const base = {
    persona: AGENT.persona,
    topic: "Should the speed limit change?",
    readWindowSize: 20,
  };

  test("with no history, states nothing has been posted yet", () => {
    const prompt = buildSystemPrompt({ ...base, ownMessageHistory: [] });
    expect(prompt).toContain("You have not yet posted anything in this conversation.");
  });

  test("quotes recent messages and tells the agent not to restate them", () => {
    const prompt = buildSystemPrompt({
      ...base,
      ownMessageHistory: ["I think a 30 limit is right", "The data supports it"],
    });
    expect(prompt).toContain("> I think a 30 limit is right");
    expect(prompt).toContain("> The data supports it");
    expect(prompt).toContain("Do not restate them");
  });

  test("quotes every line of a multi-line post so none leaks unquoted", () => {
    const prompt = buildSystemPrompt({
      ...base,
      ownMessageHistory: ["First line.\nSecond line."],
    });
    expect(prompt).toContain("> First line.\n> Second line.");
    // The bare continuation line must not appear as prompt instructions.
    expect(prompt).toContain("> Second line.");
  });
});

describe("buildTickMessage", () => {
  test("tick 1 with nothing new carries head and no-news clause", () => {
    const msg = buildTickMessage({ tick: 1, totalTicks: 7, newMessages: 0 });
    expect(msg).toContain("Tick 1 of 7.");
    expect(msg).toContain("Nothing new since your last turn.");
  });

  test("final tick keeps the same shape", () => {
    const msg = buildTickMessage({ tick: 7, totalTicks: 7, newMessages: 2 });
    expect(msg).toContain("Tick 7 of 7.");
    expect(msg).toContain("2 new messages since your last turn.");
  });

  test("singular new-message wording for a single new message", () => {
    const msg = buildTickMessage({ tick: 3, totalTicks: 5, newMessages: 1 });
    expect(msg).toContain("1 new message since your last turn.");
  });

  test("quotes the agent's own last message and says not to restate it", () => {
    const msg = buildTickMessage({
      tick: 4,
      totalTicks: 6,
      newMessages: 3,
      ownLastMessage: "I think 30 is the right cap",
    });
    expect(msg).toContain('You already said: "I think 30 is the right cap".');
    expect(msg).toContain("Don't restate it.");
  });

  test("quotes only the first line of a multi-line own post", () => {
    const msg = buildTickMessage({
      tick: 2,
      totalTicks: 4,
      newMessages: 1,
      ownLastMessage: "First line.\nSecond line.",
    });
    expect(msg).toContain('"First line."');
    expect(msg).not.toContain("Second line.");
  });

  test("omits the own-message clause when the agent has posted nothing", () => {
    const msg = buildTickMessage({ tick: 1, totalTicks: 5, newMessages: 0 });
    expect(msg).not.toContain("already said");
  });

  test("stays under 200 chars even with a quoted last message", () => {
    const msg = buildTickMessage({
      tick: 12,
      totalTicks: 12,
      newMessages: 9,
      ownLastMessage: "A fairly long message that the agent has already posted and should not restate.",
    });
    expect(msg.length).toBeLessThan(200);
  });

  test("truncates an over-long own last message so the tick message stays short", () => {
    const veryLong = "x".repeat(500);
    const msg = buildTickMessage({ tick: 1, totalTicks: 3, newMessages: 1, ownLastMessage: veryLong });
    expect(msg.length).toBeLessThan(200);
    expect(msg).toContain("…");
  });
});

describe("AgentRuntime new-message tracking", () => {
  test("reports messages that arrived between turns as new", async () => {
    // The runtime counts the room itself at the start of each tick. Tick 1
    // starts a fresh run, so it reports nothing new; 3 messages arrive before
    // tick 2, and its message reports 3 new.
    let reads = 0;
    mcp.callTool = async (name: string) => {
      if (name !== "matrix_read_room") return "{}";
      reads += 1;
      return reads === 1
        ? JSON.stringify([{}, {}, {}, {}])
        : JSON.stringify([{}, {}, {}, {}, {}, {}, {}]);
    };

    // The model needn't read for the news to be counted; give it a no-op turn.
    script = [assistant([stanceCall()]), assistant(), assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTick(1, 5);
    expect(runtime.getLastTickMessage()).toContain("Nothing new since your last turn.");

    await runtime.runTick(2, 5);
    expect(runtime.getLastTickMessage()).toContain("3 new messages since your last turn.");
    expect(runtime.getLastTickMessage()).toContain("Tick 2 of 5.");
  });

  test("single new message uses singular wording", async () => {
    let reads = 0;
    mcp.callTool = async (name: string) => {
      if (name !== "matrix_read_room") return "{}";
      reads += 1;
      return reads === 1 ? "[]" : JSON.stringify([{}]);
    };

    script = [assistant([stanceCall()]), assistant(), assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTick(1, 5);
    await runtime.runTick(2, 5);
    expect(runtime.getLastTickMessage()).toContain("1 new message since your last turn.");
  });

  test("an unreadable room degrades to nothing new without failing the tick", async () => {
    mcp.callTool = async (name: string) => {
      // Both the count-read and any send fail catastrophically.
      throw new Error("homeserver unreachable");
    };
    script = [assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTick(1, 5);
    expect(runtime.getLastTickMessage()).toContain("Nothing new since your last turn.");
  });
});
