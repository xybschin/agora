/**
 * Pins the agent runtime's (loop.ts) behaviour: the Own message history queue,
 * the system prompt and per-turn message it feeds the model, new-message
 * counting, the guards that keep a malformed tool call from dropping a Turn or
 * corrupting the stance, the Turn bracket events, and runLoop's recovery from
 * failed waits and failed turns.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDefinition } from "@agora/shared";
import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";
import type {
  PostOutcome,
  ReactionOutcome,
  ReplyOutcome,
  RoomMessage,
  SentMessage,
} from "./mcpClient.js";

// loop.ts drives its tool loop through `chatCompletion` from ./llm.js, so to
// script what the model decides to do (which tool it calls, or whether it
// stops) that module is mocked here, before ./loop.js is imported. The mcp
// client is passed in as a plain stub, so the send tools' (matrix_post and
// matrix_reply) success and failure paths are both reachable without a real homeserver.
//
// The mock replays a scripted list of assistant messages, one per
// chatCompletion call; a message with no tool_calls ends the turn. A scripted
// Error is thrown instead, standing in for a provider failure that outlasted
// chatCompletion's own retries.
type ScriptedMessage = ChatMessage & { tool_calls?: ToolCall[] };

let script: Array<ScriptedMessage | Error> = [];
// The messages of every chatCompletion call, so a test can read the prompts a
// turn was given.
let llmCalls: ChatMessage[][] = [];

mock.module("./llm.js", () => ({
  chatCompletion: async (_llm: unknown, messages: ChatMessage[]) => {
    llmCalls.push([...messages]);
    const next = script.shift();
    if (!next) throw new Error("test script exhausted: no more assistant messages");
    if (next instanceof Error) throw next;
    return { message: next, usage: { promptTokens: 5, completionTokens: 5 } };
  },
}));

const { AgentRuntime, buildTurnMessage } = await import("./loop.js");
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

/** A Room post (matrix_post) of `content`. */
function sendCall(content: string): ToolCall {
  return {
    id: `call_${content}`,
    type: "function",
    function: { name: "matrix_post", arguments: JSON.stringify({ content }) },
  };
}

/** A Reply (matrix_reply) of `content` to the message `eventId`. */
function replyCall(eventId: string, content: string): ToolCall {
  return {
    id: `call_reply_${content}`,
    type: "function",
    function: { name: "matrix_reply", arguments: JSON.stringify({ eventId, content }) },
  };
}

/** A send tool call whose arguments can be made to lack a body on purpose. */
function rawSendCall(argumentsJson: string, name = "matrix_post"): ToolCall {
  return {
    id: "call_send_raw",
    type: "function",
    function: { name, arguments: argumentsJson },
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

/** A bare update_stance call whose arguments can be made malformed on purpose. */
function rawStanceCall(argumentsJson: string): ToolCall {
  return {
    id: "call_stance",
    type: "function",
    function: { name: "update_stance", arguments: argumentsJson },
  };
}

function assistant(tool_calls?: ToolCall[]): ScriptedMessage {
  return { role: "assistant", content: tool_calls ? "thinking..." : "done", tool_calls };
}

// A module-level room stub whose operations are swapped per test to simulate a
// successful send, a refusal, or a hard failure. listToolSpecs returns no extra
// tools; the runtime adds stance itself. waitForActivity is exercised by the
// runLoop tests and stubbed to not block.
//
// The stub speaks the room interface rather than MCP tool names and JSON
// envelopes, so the tests describe what the runtime asked the room to do.
const SENT: SentMessage = { id: "$evt", createdAt: "2026-01-01T00:00:00Z" };
const POSTED: PostOutcome = { kind: "sent", message: SENT };
const REPLIED: ReplyOutcome = { kind: "sent", message: SENT };

function roomOf(n: number): RoomMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    eventId: `$m${i}`,
    sender: "@member:localhost",
    senderDisplayName: "Member",
    content: `message ${i}`,
    createdAt: "2026-01-01T00:00:00Z",
  }));
}

const mcp: {
  listToolSpecs: () => ToolSpec[];
  readRoom: (limit?: number) => Promise<RoomMessage[]>;
  reply: (eventId: string, content: string) => Promise<ReplyOutcome>;
  post: (content: string) => Promise<PostOutcome>;
  addReaction: (eventId: string, reaction: string) => Promise<ReactionOutcome>;
  waitForActivity: (args: { timeoutMs: number; since?: string }) => Promise<{
    hasActivity: boolean;
    nextBatch: string;
  }>;
} = {
  listToolSpecs: () => [],
  readRoom: async () => [],
  reply: async () => REPLIED,
  post: async () => POSTED,
  addReaction: async () => ({ kind: "done" }),
  waitForActivity: async () => ({ hasActivity: false, nextBatch: "s1" }),
};

beforeEach(() => {
  mcp.listToolSpecs = () => [];
  mcp.readRoom = async () => [];
  mcp.reply = async () => REPLIED;
  mcp.post = async () => POSTED;
  mcp.addReaction = async () => ({ kind: "done" });
  mcp.waitForActivity = async () => ({ hasActivity: false, nextBatch: "s1" });
});

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return new AgentRuntime({
    runId: "scenario-test",
    agentId: "alice",
    agentDef: AGENT,
    topic: "Should the speed limit change?",
    roomId: "!room:localhost",
    matrixUserId: "@alice:localhost",
    maxToolStepsPerTurn: 10,
    logDir: "/tmp/agora-loop-test",
    mcp: mcp as never,
    llm: { baseUrl: "http://test/v1", apiKey: "k", model: "m" },
    ...overrides,
  });
}

describe("AgentRuntime own message history", () => {
  test("a successfully posted message is remembered in the queue", async () => {
    script = [assistant([sendCall("I think a 30 limit is right")]), assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTurn();

    expect(runtime.getOwnMessageHistory()).toEqual(["I think a 30 limit is right"]);
  });

  test("a failed send is not remembered as a commitment", async () => {
    script = [assistant([sendCall("this should not stick")]), assistant([stanceCall()]), assistant()];
    // Hard failure: the room call throws, so the send never completes and the
    // queue must not advance.
    mcp.post = async () => {
      throw new Error("homeserver rejected the message");
    };

    const runtime = makeRuntime();
    await expect(runtime.runTurn()).rejects.toThrow();
    expect(runtime.getOwnMessageHistory()).toEqual([]);
  });

  test("a malformed send (missing content) is returned to the model to self-correct, not thrown", async () => {
    // Script the model first calling a send tool with no body, then --
    // on seeing the rejection -- retrying with a real message. The turn must
    // survive the malformed call (the run was failing every turn on exactly
    // this), and the corrected message must be the only thing posted.
    script = [
      assistant([rawSendCall(JSON.stringify({ eventId: "$earlier" }), "matrix_reply")]),
      assistant([sendCall("I think a 30 limit is right")]),
      assistant([stanceCall()]),
      assistant(),
    ];
    const sent: Array<{ kind: "post"; content: string } | { kind: "reply"; eventId: string; content: string }> =
      [];
    mcp.post = async (content) => {
      sent.push({ kind: "post", content });
      return POSTED;
    };
    mcp.reply = async (eventId, content) => {
      sent.push({ kind: "reply", eventId, content });
      return REPLIED;
    };

    const runtime = makeRuntime();
    await runtime.runTurn(); // does not throw

    // The empty-body call never reached the room; only the correction did, and a
    // successful post is remembered as usual.
    expect(sent).toEqual([{ kind: "post", content: "I think a 30 limit is right" }]);
    expect(runtime.getOwnMessageHistory()).toEqual(["I think a 30 limit is right"]);
  });

  test("a send with an empty-string content is corrected, never posted", async () => {
    // Whitespace-only content is refused up front too; the model then chooses
    // not to post at all, and nothing lands in the room or the committed queue.
    script = [
      assistant([rawSendCall(JSON.stringify({ content: "   " }))]),
      assistant([stanceCall()]),
      assistant(),
    ];
    const sent: Array<{ kind: "post"; content: string } | { kind: "reply"; eventId: string; content: string }> =
      [];
    mcp.post = async (content) => {
      sent.push({ kind: "post", content });
      return POSTED;
    };
    mcp.reply = async (eventId, content) => {
      sent.push({ kind: "reply", eventId, content });
      return REPLIED;
    };

    const runtime = makeRuntime();
    await runtime.runTurn();

    expect(sent).toHaveLength(0);
    expect(runtime.getOwnMessageHistory()).toEqual([]);
  });

  test("memory is isolated per agent", async () => {
    script = [assistant([sendCall("Alice posts")]), assistant([stanceCall()]), assistant()];

    const alice = makeRuntime({ agentId: "alice", agentDef: { ...AGENT, id: "alice" } });
    const bob = makeRuntime({
      agentId: "bob",
      agentDef: { ...AGENT, id: "bob", persona: { ...AGENT.persona, displayName: "Bob" } },
    });

    // Only alice takes a turn; bob never posts and must not see her memory.
    await alice.runTurn();

    expect(alice.getOwnMessageHistory()).toEqual(["Alice posts"]);
    expect(bob.getOwnMessageHistory()).toEqual([]);
  });

  test("memory is isolated per run: each fresh runtime starts empty", async () => {
    script = [assistant([sendCall("run one post")]), assistant([stanceCall()]), assistant()];

    // A new Run is a fresh agent container with its own runtime (per
    // architecture each Run's compose stack is brought up separately), so it
    // must begin with an empty queue even though an earlier Run posted.
    const run1 = makeRuntime({ runId: "scenario-20260101-0100" });
    await run1.runTurn();
    expect(run1.getOwnMessageHistory()).toHaveLength(1);

    const run2 = makeRuntime({ runId: "scenario-20260101-0200" });
    expect(run2.getOwnMessageHistory()).toEqual([]);
  });

  test("the seed author starts with the seed it posted as its own message", async () => {
    // The runner posted the seed with this agent's account, so it is the
    // agent's first message of the Run, and its first turn is told so.
    script = [assistant()];

    const runtime = makeRuntime({ seedMessage: "The floor is yours." });
    expect(runtime.getOwnMessageHistory()).toEqual(["The floor is yours."]);

    await runtime.runTurn();
    expect(String(llmCalls.at(-1)?.[0]?.content)).toContain("> The floor is yours.");
  });

  test("an agent that did not author the seed starts with an empty queue", () => {
    expect(makeRuntime().getOwnMessageHistory()).toEqual([]);
  });

  test("the queue is bounded to the most recent posts, dropping the oldest", async () => {
    // Post four messages in one turn; the queue must keep only the last three
    // and forget the first (which is still visible in room history if read).
    script = [
      assistant([sendCall("one"), sendCall("two"), sendCall("three"), sendCall("four")]),
      assistant([stanceCall()]),
      assistant(),
    ];

    const runtime = makeRuntime();
    await runtime.runTurn();

    expect(runtime.getOwnMessageHistory()).toEqual(["two", "three", "four"]);
  });
});

describe("AgentRuntime Reply and Room post (ADR-0010)", () => {
  // Every agent message is exactly one Reply or one Room post, chosen by tool.
  // The transcript's `message` event is where that choice is read back from:
  // replyToEventId present means a Reply, absent means a deliberate Room post.
  async function messageEventsAfter(calls: ToolCall[]) {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-reply-post-"));
    script = [assistant(calls), assistant([stanceCall()]), assistant()];
    const sent: Array<
      { kind: "post"; content: string } | { kind: "reply"; eventId: string; content: string }
    > = [];
    mcp.post = async (content) => {
      sent.push({ kind: "post", content });
      return POSTED;
    };
    mcp.reply = async (eventId, content) => {
      sent.push({ kind: "reply", eventId, content });
      return REPLIED;
    };
    const runtime = makeRuntime({ logDir });
    await runtime.runTurn();
    const raw = await readFile(path.join(logDir, "scenario-test", "events.jsonl"), "utf8");
    const messages = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.type === "message");
    return { messages, sent, runtime };
  }

  test("a Reply reaches the server with its target and records replyToEventId", async () => {
    const { messages, sent, runtime } = await messageEventsAfter([replyCall("$bob1", "I disagree, Bob")]);

    expect(sent).toEqual([{ kind: "reply", eventId: "$bob1", content: "I disagree, Bob" }]);
    expect(messages).toEqual([
      expect.objectContaining({ content: "I disagree, Bob", replyToEventId: "$bob1", matrixEventId: "$evt" }),
    ]);
    // A Reply is the agent's own message like any other.
    expect(runtime.getOwnMessageHistory()).toEqual(["I disagree, Bob"]);
  });

  test("a Room post records no replyToEventId", async () => {
    const { messages, sent } = await messageEventsAfter([sendCall("A new point for everyone")]);

    expect(sent).toEqual([{ kind: "post", content: "A new point for everyone" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("replyToEventId");
  });

  test("a Room post that smuggles in a reply target still records none", async () => {
    // matrix_post has no target; a stray argument must not turn it into a
    // Reply in the transcript.
    const { messages } = await messageEventsAfter([
      rawSendCall(JSON.stringify({ content: "to everyone", eventId: "$x", replyToEventId: "$y" })),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("replyToEventId");
  });

  test("a Reply with no content is refused as a tool result naming matrix_reply", async () => {
    script = [
      assistant([rawSendCall(JSON.stringify({ eventId: "$bob1" }), "matrix_reply")]),
      assistant([stanceCall()]),
      assistant(),
    ];
    const sent: unknown[] = [];
    mcp.reply = async (eventId, content) => {
      sent.push({ eventId, content });
      return REPLIED;
    };
    llmCalls = [];
    await makeRuntime().runTurn();

    expect(sent).toHaveLength(0);
    const refusal = llmCalls[1]!.find((m) => m.role === "tool");
    expect(String(refusal?.content)).toContain("matrix_reply rejected: 'content' must be a non-empty string");
  });
});

describe("AgentRuntime rejected Replies (agora-jb3.2)", () => {
  // The MCP server refuses a Reply to the agent's own message, a reaction or an
  // unknown id with an ordinary { rejected } result and sends nothing. The loop
  // must hand that back to the model within the Turn, not fail the Turn.
  const REJECTION = "matrix_reply rejected: $mine is your own message. Use matrix_post.";

  /** Rejects Replies to `$mine`, accepts every other send; records what was sent. */
  function rejectingOwnTarget() {
    const sent: Array<
      { kind: "post"; content: string } | { kind: "reply"; eventId: string; content: string }
    > = [];
    mcp.reply = async (eventId, content) => {
      if (eventId === "$mine") return { kind: "rejected", reason: REJECTION };
      sent.push({ kind: "reply", eventId, content });
      return REPLIED;
    };
    mcp.post = async (content) => {
      sent.push({ kind: "post", content });
      return POSTED;
    };
    return sent;
  }

  async function readEvents(logDir: string) {
    const raw = await readFile(path.join(logDir, "scenario-test", "events.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test("a rejection is the tool result, and the model's retry within the Turn is posted", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-reply-rejected-"));
    script = [
      assistant([replyCall("$mine", "adding to myself")]),
      assistant([replyCall("$bob1", "I disagree, Bob")]),
      assistant([stanceCall()]),
      assistant(),
    ];
    const sent = rejectingOwnTarget();
    llmCalls = [];
    const runtime = makeRuntime({ logDir });
    await runtime.runTurn();

    // The model saw the reason before its second step.
    const toolResult = llmCalls[1]!.find((m) => m.role === "tool");
    expect(String(toolResult?.content)).toContain(REJECTION);

    const events = await readEvents(logDir);
    expect(events.filter((e) => e.type === "reply_rejected")).toEqual([
      expect.objectContaining({
        runId: "scenario-test",
        agentId: "alice",
        turn: 1,
        targetEventId: "$mine",
        reason: REJECTION,
        timestamp: expect.any(String),
      }),
    ]);
    // Only the retry reached the room and the transcript.
    expect(sent).toEqual([{ kind: "reply", eventId: "$bob1", content: "I disagree, Bob" }]);
    expect(events.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ content: "I disagree, Bob", replyToEventId: "$bob1" }),
    ]);
    expect(runtime.getOwnMessageHistory()).toEqual(["I disagree, Bob"]);
  });

  test("a rejection the model does not retry leaves no message event and the Turn ends normally", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-reply-rejected-"));
    script = [assistant([replyCall("$mine", "adding to myself")]), assistant([stanceCall()]), assistant()];
    rejectingOwnTarget();
    const runtime = makeRuntime({ logDir });
    await runtime.runTurn(); // does not throw

    const types = (await readEvents(logDir)).map((e) => e.type);
    expect(types).toContain("reply_rejected");
    expect(types).not.toContain("message");
    expect(types).toContain("agent_turn_ended");
    expect(types).not.toContain("agent_turn_failed");
    expect(runtime.getOwnMessageHistory()).toEqual([]);
  });
});

describe("buildSystemPrompt own-message section", () => {
  const base = {
    persona: AGENT.persona,
    topic: "Should the speed limit change?",
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

describe("buildSystemPrompt speaking contract", () => {
  const base = {
    persona: AGENT.persona, // conformity 0.5, assertiveness 0.5, openness 0.5
    topic: "Should the speed limit change?",
    ownMessageHistory: [],
  };

  function promptFor(overrides: Record<string, unknown> = {}) {
    return buildSystemPrompt({ ...base, ...overrides });
  }

  // A persona at each trait's extremes, to exercise the low/high trait readings.
  const lowPersona = {
    ...AGENT.persona,
    traits: { conformity: 0.1, assertiveness: 0.1, opennessToEvidence: 0.1 },
  };
  const highPersona = {
    ...AGENT.persona,
    traits: { conformity: 0.9, assertiveness: 0.9, opennessToEvidence: 0.9 },
  };

  test("no longer dumps raw trait numbers or the old 0=low,1=high rubric", () => {
    const prompt = promptFor();
    expect(prompt).not.toMatch(/conformity:\s*0\.5/);
    expect(prompt).not.toMatch(/0=low/);
    expect(prompt).not.toMatch(/1=high/);
    expect(prompt).not.toMatch(/assertiveness:\s*0\.5/);
    expect(prompt).not.toMatch(/opennessToEvidence:\s*0\.5/);
  });

  test("does not let any trait name appear as a labelled number", () => {
    // Even at the extremes, no trait prints as "key: <value>".
    for (const persona of [lowPersona, highPersona]) {
      const p = buildSystemPrompt({ ...base, persona });
      expect(p).not.toMatch(/conformity:\s*\d/);
      expect(p).not.toMatch(/assertiveness:\s*\d/);
      expect(p).not.toMatch(/opennessToEvidence:\s*\d/);
    }
  });

  test("still includes the character and stance lines that drive continuity", () => {
    const prompt = promptFor();
    expect(prompt).toContain(`You are ${AGENT.persona.displayName}`);
    expect(prompt).toContain(`Your character: ${AGENT.persona.flavorText}`);
    expect(prompt).toContain(`Your current private stance on the topic is ${AGENT.persona.initialStance}`);
  });

  test("describes how conformity behaves rather than printing its value", () => {
    // Middle conformity: responsive to consensus but not at the cost of judgment.
    expect(promptFor()).toContain("lean toward a clear consensus");
    // Low conformity: holds to its own reasoning, consensus does not pull it.
    expect(promptFor({ persona: lowPersona })).toContain("Consensus does not pull you");
    // High conformity: public drift beyond a guarded private stance (divergence, not mere agreement).
    const high = promptFor({ persona: highPersona });
    expect(high).toContain("go along with the room");
    expect(high).toContain("record your true private stance");
  });

  test("reframes conformity as private/public divergence, not a drive to consensus", () => {
    const prompt = promptFor({ persona: highPersona });
    // The point of high conformity is that the *public* position drifts while the
    // *private* stance stays recorded -- not that the agent must converge on the group.
    expect(prompt).toContain("stated position may drift toward the group");
    expect(prompt).toContain("record your true private stance");
    expect(prompt).not.toContain("you must agree with the group");
  });

  test("describes assertiveness behaviourally at both extremes", () => {
    expect(promptFor({ persona: highPersona })).toContain("push back and disagree openly");
    expect(promptFor({ persona: lowPersona })).toContain("preferring to soften disagreement");
  });

  test("describes openness-to-evidence behaviourally at both extremes", () => {
    expect(promptFor({ persona: highPersona })).toContain("your stance moves when the reasoning warrants it");
    expect(promptFor({ persona: lowPersona })).toContain("a good argument rarely moves you");
  });

  test("explicitly permits non-consensus outcomes", () => {
    const prompt = promptFor();
    expect(prompt).toContain("does not have to reach a consensus");
    expect(prompt).toContain("bluntly disagree");
    expect(prompt).toContain("feel awkward");
    expect(prompt).toContain("withdraw from a thread");
    expect(prompt).toContain("do not manufacture agreement for its own sake");
  });

  test("explicitly bans restating arguments, commitments, or positions", () => {
    const prompt = promptFor();
    expect(prompt).toContain("Do not restate an argument, commitment, or position");
    expect(prompt).toContain("unless something has since given it new meaning");
  });

  test("makes clear a turn with nothing to add is a valid outcome, not a failure", () => {
    const prompt = promptFor();
    expect(prompt).toContain("silence is a valid choice if you have nothing to add");
    expect(prompt).toContain("Having nothing to add is never a failure");
    expect(prompt).toContain("don't force a message");
  });

  test("offers matrix_reply and matrix_post, not the old send tool", () => {
    const prompt = promptFor();
    expect(prompt).toContain("matrix_reply");
    expect(prompt).toContain("matrix_post");
    expect(prompt).not.toContain("matrix_send_message");
    expect(prompt).not.toContain("replyToEventId");
  });

  test("states the Reply/Room post rule and the several-participants rule (ADR-0010)", () => {
    const prompt = promptFor();
    expect(prompt).toContain(
      "If your message agrees with, rebuts or builds on something a specific participant said, use matrix_reply on that message",
    );
    expect(prompt).toContain("Use matrix_post only when you are answering no one in particular");
    expect(prompt).toContain(
      "If you are answering several participants, Reply to the one you answer most directly and name the others in your text",
    );
    // The fallback quote is the system's job; an agent-written one would show twice.
    expect(prompt).toContain('Do NOT include a quote ("> ...") in the message body');
  });

  test("still quotes own message history and forbids restating it", () => {
    const prompt = buildSystemPrompt({
      ...base,
      ownMessageHistory: ["I think a 30 limit is right"],
    });
    expect(prompt).toContain("> I think a 30 limit is right");
    expect(prompt).toContain("Do not restate them");
  });
});

describe("buildTurnMessage", () => {
  test("turn 1 with nothing new carries head and no-news clause", () => {
    const msg = buildTurnMessage({ turn: 1, newMessages: 0 });
    expect(msg).toContain("Turn 1.");
    expect(msg).toContain("Nothing new since your last turn.");
  });

  test("a later turn with new messages reports them", () => {
    const msg = buildTurnMessage({ turn: 3, newMessages: 2 });
    expect(msg).toContain("Turn 3.");
    expect(msg).toContain("2 new messages since your last turn.");
  });

  test("singular new-message wording for a single new message", () => {
    const msg = buildTurnMessage({ turn: 2, newMessages: 1 });
    expect(msg).toContain("1 new message since your last turn.");
  });

  test("quotes the agent's own last message and says not to restate it", () => {
    const msg = buildTurnMessage({
      turn: 4,
      newMessages: 3,
      ownLastMessage: "I think 30 is the right cap",
    });
    expect(msg).toContain('You already said: "I think 30 is the right cap".');
    expect(msg).toContain("Don't restate it.");
  });

  test("quotes only the first line of a multi-line own post", () => {
    const msg = buildTurnMessage({
      turn: 2,
      newMessages: 1,
      ownLastMessage: "First line.\nSecond line.",
    });
    expect(msg).toContain('"First line."');
    expect(msg).not.toContain("Second line.");
  });

  test("omits the own-message clause when the agent has posted nothing", () => {
    const msg = buildTurnMessage({ turn: 1, newMessages: 0 });
    expect(msg).not.toContain("already said");
    expect(msg).not.toContain("Don't restate it");
  });

  test("stays under 200 chars even with a quoted last message", () => {
    const msg = buildTurnMessage({
      turn: 12,
      newMessages: 9,
      ownLastMessage: "A fairly long message that the agent has already posted and should not restate.",
    });
    expect(msg.length).toBeLessThan(200);
  });

  test("truncates an over-long own last message so the turn message stays short", () => {
    const veryLong = "x".repeat(500);
    const msg = buildTurnMessage({ turn: 1, newMessages: 1, ownLastMessage: veryLong });
    expect(msg.length).toBeLessThan(200);
    expect(msg).toContain("…");
  });
});

describe("AgentRuntime new-message tracking", () => {
  test("reports messages that arrived between turns as new", async () => {
    // The runtime counts the room itself at the start of each turn. Turn 1
    // starts a fresh run, so it reports nothing new; 3 messages arrive before
    // turn 2, and its message reports 3 new.
    let reads = 0;
    mcp.readRoom = async () => {
      reads += 1;
      return roomOf(reads === 1 ? 4 : 7);
    };

    // The model needn't read for the news to be counted; give it a no-op turn.
    script = [assistant([stanceCall()]), assistant(), assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTurn();
    expect(runtime.getLastTurnMessage()).toContain("Nothing new since your last turn.");

    await runtime.runTurn();
    expect(runtime.getLastTurnMessage()).toContain("3 new messages since your last turn.");
    expect(runtime.getLastTurnMessage()).toContain("Turn 2.");
  });

  test("single new message uses singular wording", async () => {
    let reads = 0;
    mcp.readRoom = async () => {
      reads += 1;
      return roomOf(reads === 1 ? 0 : 1);
    };

    script = [assistant([stanceCall()]), assistant(), assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTurn();
    await runtime.runTurn();
    expect(runtime.getLastTurnMessage()).toContain("1 new message since your last turn.");
  });

  test("an unreadable room degrades to nothing new without failing the turn", async () => {
    mcp.readRoom = async () => {
      // The count-read fails catastrophically; the turn must survive it.
      throw new Error("homeserver unreachable");
    };
    script = [assistant([stanceCall()]), assistant()];

    const runtime = makeRuntime();
    await runtime.runTurn();
    expect(runtime.getLastTurnMessage()).toContain("Nothing new since your last turn.");
  });
});

describe("AgentRuntime update_stance malformed-argument guard", () => {
  // Distinct non-zero prior so "preserved" is observable and distinguishable
  // from a fresh seed or from NaN.
  const PRIOR = 0.4;
  const stancedAgent: AgentDefinition = {
    id: "alice",
    persona: {
      displayName: "Alice",
      flavorText: "Careful and measured.",
      traits: { conformity: 0.5, assertiveness: 0.5, opennessToEvidence: 0.5 },
      initialStance: PRIOR,
    },
  };

  // Drives the real runtime (appendEvent not mocked) writing to a throwaway
  // logDir per run, then reads back the stance events it recorded so the test
  // asserts on the actual transcript/event stream, not on a stub.
  async function stanceEventsAfter(script_: Array<ScriptedMessage>) {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-stance-guard-"));
    script = script_;
    const runtime = makeRuntime({ logDir, agentDef: stancedAgent });
    await runtime.runTurn();
    const raw = await readFile(path.join(logDir, "scenario-test", "events.jsonl"), "utf8");
    return {
      runtime,
      events: raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; stance: number; rationale?: string }),
    };
  }

  test("non-numeric stance ('abc') preserves the prior stance and never corrupts it to NaN", async () => {
    const { runtime, events } = await stanceEventsAfter([
      assistant([rawStanceCall(JSON.stringify({ stance: "abc", rationale: "should not apply" }))]),
      assistant(),
    ]);

    // The persisted stance is unchanged (prior value), not NaN.
    expect(runtime.getStance()).toBe(PRIOR);
    expect(Number.isNaN(runtime.getStance())).toBe(false);

    // The dropped update is recorded in the event stream as carried over, not
    // silently dropped, and never records NaN.
    const stanceEvents = events.filter((e) => e.type === "stance");
    expect(stanceEvents).toHaveLength(1);
    const recorded = stanceEvents[0]!;
    expect(recorded.stance).toBe(PRIOR);
    expect(recorded.rationale).toContain("invalid");
    expect(recorded.rationale).toContain("carried over");
    expect(Number.isNaN(recorded.stance)).toBe(false);
  });

  test("a prior valid stance endures a malformed call and the prompt stays NaN-free", async () => {
    const { runtime } = await stanceEventsAfter([
      // Turn 1: a valid move to 0.8.
      assistant([rawStanceCall(JSON.stringify({ stance: 0.8 }))]),
      assistant(),
    ]);
    expect(runtime.getStance()).toBe(0.8);

    // Now drive another real turn in which the model emits a malformed stance.
    // The prior 0.8 (not NaN) must survive, and the system prompt rendered from
    // that persisted stance must not leak "NaN".
    script = [assistant([rawStanceCall(JSON.stringify({ stance: "0.5x" }))]), assistant()];
    await runtime.runTurn();

    expect(runtime.getStance()).toBe(0.8);
    const prompt = buildSystemPrompt({
      persona: stancedAgent.persona,
      topic: "Should the speed limit change?",
      currentStance: runtime.getStance(),
      isFirstTurn: false,
      ownMessageHistory: [],
    });
    expect(prompt).toContain("private stance on the topic is 0.8");
    expect(prompt).not.toContain("NaN");
  });

  test("a finite out-of-range stance is still clamped to [-1, 1]", async () => {
    const { runtime } = await stanceEventsAfter([
      assistant([rawStanceCall(JSON.stringify({ stance: 5 }))]),
      assistant(),
    ]);
    expect(runtime.getStance()).toBe(1);

    const { runtime: neg } = await stanceEventsAfter([
      assistant([rawStanceCall(JSON.stringify({ stance: -7 }))]),
      assistant(),
    ]);
    expect(neg.getStance()).toBe(-1);
  });

  test("valid numeric stance inside range records as given", async () => {
    const { runtime } = await stanceEventsAfter([
      assistant([rawStanceCall(JSON.stringify({ stance: -0.5, rationale: "leaning against" }))]),
      assistant(),
    ]);
    expect(runtime.getStance()).toBe(-0.5);
  });

  test("empty-string stance is handled by the finite-number guard (Number('') is 0), not by emptiness", async () => {
    // Number("") is 0 -- a finite number -- so it records as 0 under the
    // finite-number guard, rather than being rejected because it is empty or
    // corrupting the stance. This pins the "finite-number check, not emptiness"
    // requirement from the brief.
    const { runtime } = await stanceEventsAfter([
      assistant([rawStanceCall(JSON.stringify({ stance: "" }))]),
      assistant(),
    ]);
    expect(runtime.getStance()).toBe(0);
    expect(Number.isNaN(runtime.getStance())).toBe(false);
  });
});

describe("AgentRuntime turn bracketing events", () => {
  // Drives real runTurn calls writing to a throwaway logDir, then reads back
  // the agent_turn_started/agent_turn_ended events so the test asserts the
  // per-agent turn liveness evidence, not a stub.
  async function turnEventsAfter(script_: Array<ScriptedMessage | Error>, runTurns = 1) {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-turn-bracket-"));
    const runtime = makeRuntime({ logDir });
    // A full 3-slot script per runTurn: turn, stance, stop.
    for (let i = 0; i < runTurns; i++) {
      script = [...script_];
      await runtime.runTurn();
    }
    const raw = await readFile(path.join(logDir, "scenario-test", "events.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(line) as {
          type: string;
          agentId?: string;
          turn?: number;
          seq?: number;
        },
      );
  }

  const noopTurn = [assistant([stanceCall()]), assistant()];

  test("brackets a single turn with agent_turn_started/agent_turn_ended at turn 1", async () => {
    const events = await turnEventsAfter(noopTurn);
    const turns = events.filter((e) => e.type.startsWith("agent_turn_"));
    expect(turns).toEqual([
      expect.objectContaining({ type: "agent_turn_started", agentId: "alice", turn: 1 }),
      expect.objectContaining({ type: "agent_turn_ended", agentId: "alice", turn: 1 }),
    ]);
  });

  test("increments the per-agent turn counter across successive turns, starting at 1", async () => {
    const events = await turnEventsAfter(noopTurn, 2);
    const turns = events.filter((e) => e.type.startsWith("agent_turn_"));
    expect(turns.map((e) => [e.type, e.turn])).toEqual([
      ["agent_turn_started", 1],
      ["agent_turn_ended", 1],
      ["agent_turn_started", 2],
      ["agent_turn_ended", 2],
    ]);
  });

  test("writes each turn's events in write order by seq", async () => {
    const events = await turnEventsAfter(noopTurn, 2);
    const seqs = events.map((e) => e.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("AgentRuntime continuous event-driven loop (runLoop)", () => {
  // runLoop() is infinite by design; each test bounds it with an `isStopped`
  // predicate that trips once the configured number of waits has happened, and
  // drives `waitForActivity` from the module-level `mcp` stub. Events land in a
  // throwaway logDir so the assertions read the actual transcript.
  async function runLoopOnce(
    steps: number,
    behavior: (n: number, args: { timeoutMs: number; since?: string }) => Promise<{
      hasActivity: boolean;
      nextBatch: string;
    }>,
    overrides: Record<string, unknown> = {},
  ) {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-runloop-"));
    let waited = 0;
    const waits: Array<{ timeoutMs: number; since?: string }> = [];
    mcp.waitForActivity = async (args) => {
      waits.push(args);
      waited += 1;
      return behavior(waited, args);
    };
    const runtime = makeRuntime({
      logDir,
      waitTimeoutMs: 100,
      isStopped: () => waited >= steps,
      waitBackoff: { sleep: async () => {} },
      ...overrides,
    });
    await runtime.runLoop();
    const raw = await readFile(path.join(logDir, "scenario-test", "events.jsonl"), "utf8");
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            agentId?: string;
            turn?: number;
            state?: string;
            error?: string;
          },
      );
    return { events, waits, runtime };
  }

  test("emits a waiting heartbeat, then runs a turn when activity arrives", async () => {
    // First wait returns activity (the loop takes a turn), second returns none
    // (the loop just re-waits); two waits bound the run.
    script = [assistant([stanceCall()]), assistant()]; // one turn's script
    const { events, waits } = await runLoopOnce(2, async (n) =>
      n === 1 ? { hasActivity: true, nextBatch: "s2" } : { hasActivity: false, nextBatch: "s3" },
    );

    // A waiting heartbeat brackets the wait period.
    const heartbeats = events.filter((e) => e.type === "agent_heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    for (const hb of heartbeats) expect(hb.state).toBe("waiting");

    // Exactly one turn ran (the activity arrived on the first wait), bracketed
    // by its turn pair.
    const turns = events.filter((e) => e.type.startsWith("agent_turn_"));
    expect(turns).toEqual([
      expect.objectContaining({ type: "agent_turn_started", turn: 1 }),
      expect.objectContaining({ type: "agent_turn_ended", turn: 1 }),
    ]);

    // No room id ever reaches the long-poll tool: only timeoutMs and since.
    expect(waits.length).toBe(2);
    expect(Object.keys(waits[0]!)).toEqual(["timeoutMs", "since"]);
    expect(waits[0]!.timeoutMs).toBe(100);
    // First wait starts fresh (no since); the second resumes from the first nextBatch.
    expect(waits[0]!.since).toBeUndefined();
    expect(waits[1]!.since).toBe("s2");
  });

  test("a timed-out wait with nothing new is a normal result, not an error", async () => {
    // Every wait times out with no activity; the loop must not run a turn and
    // must keep going (bound by the stop predicate), threading the token along.
    script = [assistant([stanceCall()]), assistant()]; // must never be consumed
    const { events, waits } = await runLoopOnce(3, async (n) => ({
      hasActivity: false,
      nextBatch: `s${n + 1}`,
    }));

    expect(events.filter((e) => e.type === "agent_turn_started")).toHaveLength(0);
    expect(waits.map((w) => w.since)).toEqual([undefined, "s2", "s3"]);
  });

  test("a transient wait failure is recovered and the loop resumes", async () => {
    // First wait throws (dropped connection); the loop must not crash, and the
    // next wait must proceed -- and, because `since` only advances on success,
    // the retry must be from the same position (the token that had not yet been
    // committed). Second wait then delivers activity, which runs a turn.
    script = [assistant([stanceCall()]), assistant()];
    const { events, waits } = await runLoopOnce(3, async (n) => {
      if (n === 1) throw new Error("dropped connection");
      if (n === 2) return { hasActivity: true, nextBatch: "s2" };
      return { hasActivity: false, nextBatch: "s3" };
    });

    // The turn still ran after the failure recovered (one bracketed turn).
    const starts = events.filter((e) => e.type === "agent_turn_started");
    expect(starts.map((e) => e.turn)).toEqual([1]);
    const ends = events.filter((e) => e.type === "agent_turn_ended");
    expect(ends.map((e) => e.turn)).toEqual([1]);

    // The failed wait committed no token; the retry still had `since` undefined,
    // and the successful wait threaded its nextBatch forward.
    expect(waits.map((w) => w.since)).toEqual([undefined, undefined, "s2"]);
  });

  /** Turn retry settings with a recording, non-blocking sleep. */
  function fastTurnRetry(maxRetries: number) {
    const sleeps: number[] = [];
    const turnRetry = {
      maxRetries,
      baseDelayMs: 1_000,
      maxDelayMs: 3_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };
    return { turnRetry, sleeps };
  }

  test("a failed turn is re-run after a backoff, without waiting for new room activity", async () => {
    // The provider is out of capacity on turn 1 (run abortion-policy-20261007-0937):
    // in a fresh room nobody else will speak, so waiting for new activity would
    // stall forever. The turn is re-run after a backoff instead, and posts.
    script = [
      new Error("429 No capacity available"),
      assistant([sendCall("hello room"), stanceCall()]),
      assistant(),
    ];
    const { turnRetry, sleeps } = fastTurnRetry(3);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events, waits } = await runLoopOnce(
        1,
        async () => ({ hasActivity: true, nextBatch: "s2" }),
        { turnRetry },
      );

      const turns = events.filter((e) => e.type.startsWith("agent_turn_"));
      expect(turns).toEqual([
        expect.objectContaining({ type: "agent_turn_started", turn: 1 }),
        expect.objectContaining({
          type: "agent_turn_failed",
          runId: "scenario-test",
          agentId: "alice",
          turn: 1,
          error: "429 No capacity available",
          timestamp: expect.any(String),
        }),
        expect.objectContaining({ type: "agent_turn_started", turn: 2 }),
        expect.objectContaining({ type: "agent_turn_ended", turn: 2 }),
      ]);
      expect(events.filter((e) => e.type === "message")).toHaveLength(1);
      // The retry needed no second wake: one wait, one backoff.
      expect(waits.length).toBe(1);
      expect(sleeps).toEqual([1_000]);
    } finally {
      errors.mockRestore();
    }
  });

  test("turn retries are capped; past the cap the failure is recorded and the loop resumes waiting", async () => {
    // A persistently-down provider must not spin the agent forever: after the
    // first attempt plus maxRetries re-runs, each recorded in the transcript
    // (not just stderr), the loop goes back to waiting.
    script = [new Error("429 No capacity available"), new Error("429 No capacity available"), new Error("503")];
    const { turnRetry, sleeps } = fastTurnRetry(2);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events, waits } = await runLoopOnce(
        2,
        async (n) => (n === 1 ? { hasActivity: true, nextBatch: "s2" } : { hasActivity: false, nextBatch: "s3" }),
        { turnRetry },
      );

      const turns = events.filter((e) => e.type.startsWith("agent_turn_"));
      expect(turns.map((e) => [e.type, e.turn, e.error])).toEqual([
        ["agent_turn_started", 1, undefined],
        ["agent_turn_failed", 1, "429 No capacity available"],
        ["agent_turn_started", 2, undefined],
        ["agent_turn_failed", 2, "429 No capacity available"],
        ["agent_turn_started", 3, undefined],
        ["agent_turn_failed", 3, "503"],
      ]);
      // Backoff grows between retries; none is taken after the last attempt.
      expect(sleeps).toEqual([1_000, 2_000]);
      // The loop survived to wait again, resuming from the committed token.
      expect(waits.map((w) => w.since)).toEqual([undefined, "s2"]);

      // Logged as turn failures, not misreported as failed waits.
      const logged = errors.mock.calls.map((args) => String(args[0]));
      expect(logged.some((line) => line.includes("turn 1 failed"))).toBe(true);
      expect(logged.some((line) => line.includes("waiting for room activity failed"))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  test("a re-run turn still reports the room activity that woke it", async () => {
    // Turn 1 completes with 2 messages in the room. The next wake finds 5; that
    // attempt fails, and its re-run must still report the 3 new messages rather
    // than treat the failed attempt as having seen them.
    script = [
      assistant([stanceCall()]),
      assistant(),
      new Error("429 No capacity available"),
      assistant([stanceCall()]),
      assistant(),
    ];
    llmCalls = [];
    const { turnRetry } = fastTurnRetry(3);
    const room = (n: number) => roomOf(n);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runLoopOnce(
        2,
        async (n) => {
          mcp.readRoom = async () => room(n === 1 ? 2 : 5);
          return { hasActivity: true, nextBatch: `s${n + 1}` };
        },
        { turnRetry },
      );

      const turnMessages = llmCalls.map((call) => call.find((m) => m.role === "user")?.content ?? "");
      expect(turnMessages[0]).toMatch(/^Turn 1\. Nothing new/);
      expect(turnMessages[2]).toMatch(/^Turn 2\. 3 new messages/);
      expect(turnMessages[3]).toMatch(/^Turn 3\. 3 new messages/);
    } finally {
      errors.mockRestore();
    }
  });

  test("a re-run opening turn is still the opening turn", async () => {
    script = [new Error("429 No capacity available"), assistant([stanceCall()]), assistant()];
    llmCalls = [];
    const { turnRetry } = fastTurnRetry(3);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runLoopOnce(1, async () => ({ hasActivity: true, nextBatch: "s2" }), { turnRetry });

      const [failed, retried] = llmCalls;
      expect(retried![1]!.content).toMatch(/Nothing new since your last turn/);
      // The opening system prompt is the same on the re-run as on the failed attempt.
      expect(retried![0]!.content).toBe(failed![0]!.content);
      expect(retried![0]!.content).toMatch(/you started at/);
    } finally {
      errors.mockRestore();
    }
  });

  test("a failed turn that already posted is not re-run, so nothing is posted twice", async () => {
    // The send lands; the follow-up LLM call then fails. Re-running the turn
    // would post a second message, so the loop goes back to waiting instead.
    script = [assistant([sendCall("hello room")]), new Error("503")];
    const { turnRetry, sleeps } = fastTurnRetry(3);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events } = await runLoopOnce(1, async () => ({ hasActivity: true, nextBatch: "s2" }), {
        turnRetry,
      });

      expect(events.filter((e) => e.type === "message")).toHaveLength(1);
      expect(events.filter((e) => e.type.startsWith("agent_turn_")).map((e) => e.type)).toEqual([
        "agent_turn_started",
        "agent_turn_failed",
      ]);
      expect(sleeps).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a failed turn that already Replied is not re-run either", async () => {
    script = [assistant([replyCall("$bob1", "hello Bob")]), new Error("503")];
    const { turnRetry, sleeps } = fastTurnRetry(3);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events } = await runLoopOnce(1, async () => ({ hasActivity: true, nextBatch: "s2" }), {
        turnRetry,
      });

      expect(events.filter((e) => e.type === "message")).toHaveLength(1);
      expect(sleeps).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a failed turn whose only Reply was rejected is re-run, since nothing reached the room", async () => {
    script = [assistant([replyCall("$mine", "hello me")]), new Error("503"), assistant([stanceCall()]), assistant()];
    const { turnRetry, sleeps } = fastTurnRetry(3);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events } = await runLoopOnce(
        1,
        async () => {
          mcp.reply = async () => ({ kind: "rejected", reason: "your own message" });
          return { hasActivity: true, nextBatch: "s2" };
        },
        { turnRetry },
      );

      expect(events.filter((e) => e.type === "message")).toHaveLength(0);
      expect(events.filter((e) => e.type.startsWith("agent_turn_")).map((e) => e.type)).toEqual([
        "agent_turn_started",
        "agent_turn_failed",
        "agent_turn_started",
        "agent_turn_ended",
      ]);
      expect(sleeps).toEqual([1_000]);
    } finally {
      errors.mockRestore();
    }
  });

  test("the turn backoff is capped at maxDelayMs", async () => {
    script = Array.from({ length: 5 }, () => new Error("503"));
    const { turnRetry, sleeps } = fastTurnRetry(4);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runLoopOnce(1, async () => ({ hasActivity: true, nextBatch: "s2" }), { turnRetry });
      expect(sleeps).toEqual([1_000, 2_000, 3_000, 3_000]);
    } finally {
      errors.mockRestore();
    }
  });

  test("consecutive wait failures back off, growing to a cap, and a success resets it", async () => {
    // mcp_server is still starting: the first polls are refused. Without a
    // backoff the loop re-polled immediately and wrote ~240 heartbeats in half a
    // second. The injected sleep advances a virtual clock, so the poll times
    // below are what real time would show.
    let clock = 0;
    const sleeps: number[] = [];
    const pollTimes: number[] = [];
    const waitBackoff = {
      baseDelayMs: 250,
      maxDelayMs: 2_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events, waits } = await runLoopOnce(
        23,
        async (n) => {
          pollTimes.push(clock);
          if (n <= 20) throw new Error("ConnectionRefused");
          if (n === 21) return { hasActivity: false, nextBatch: "s2" };
          if (n === 22) throw new Error("ConnectionRefused");
          return { hasActivity: false, nextBatch: "s3" };
        },
        { waitBackoff },
      );

      // Delays double from the base up to the cap; the success after the 20th
      // failure resets them, so the next failure waits the base delay again.
      expect(sleeps).toEqual([
        250, 500, 1_000, ...Array.from({ length: 17 }, () => 2_000),
        250,
      ]);
      // Heartbeats stay bounded: one per poll, and only a handful of polls in
      // the first second rather than hundreds.
      const heartbeats = events.filter((e) => e.type === "agent_heartbeat");
      expect(heartbeats).toHaveLength(waits.length);
      expect(pollTimes.filter((t) => t < 1_000)).toHaveLength(3);
      // The token only advances on a successful wait.
      expect(waits.map((w) => w.since)).toEqual([
        ...Array.from({ length: 21 }, () => undefined),
        "s2",
        "s2",
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a failed wait is not recorded as a failed turn", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { events } = await runLoopOnce(2, async (n) => {
        if (n === 1) throw new Error("dropped connection");
        return { hasActivity: false, nextBatch: "s2" };
      });

      expect(events.filter((e) => e.type === "agent_turn_failed")).toHaveLength(0);
      const logged = warnings.mock.calls.map((args) => String(args[0]));
      expect(logged.some((line) => line.includes("waiting for room activity failed"))).toBe(true);
    } finally {
      warnings.mockRestore();
    }
  });
});
