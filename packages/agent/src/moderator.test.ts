import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";

// moderator.ts drives its tool loop through chatCompletion, so we mock
// that before importing the module. The mcp client is passed in as a stub.
type ScriptedMessage = ChatMessage & { tool_calls?: ToolCall[] };

let script: Array<ScriptedMessage> = [];
// The messages of every chatCompletion call, so a test can read the turn
// message the Moderator was given.
let llmCalls: ChatMessage[][] = [];

mock.module("./llm.js", () => ({
  chatCompletion: async (_llm: unknown, messages: ChatMessage[]) => {
    llmCalls.push([...messages]);
    const next = script.shift();
    if (!next) throw new Error("test script exhausted: no more assistant messages");
    return { message: next, usage: { promptTokens: 5, completionTokens: 5 } };
  },
}));

const { ModeratorRuntime, buildModeratorTurnMessage } = await import("./moderator.js");

const SETUP_USER_ID = "@moderator:example.com";
const ROOM_ID = "!test:example.com";
const RUN_ID = "test-run-1";

function classifyCall(classification: "active" | "stale", rationale: string): ToolCall {
  return {
    id: "call_classify",
    type: "function",
    function: {
      name: "classify_discussion",
      arguments: JSON.stringify({ classification, rationale }),
    },
  };
}

function readRoomCall(): ToolCall {
  return {
    id: "call_read",
    type: "function",
    function: {
      name: "matrix_read_room",
      arguments: JSON.stringify({ limit: 100 }),
    },
  };
}

function sendCall(content: string): ToolCall {
  return {
    id: "call_send",
    type: "function",
    function: {
      name: "matrix_send_message",
      arguments: JSON.stringify({ content }),
    },
  };
}

function assistant(tool_calls?: ToolCall[]): ScriptedMessage {
  return { role: "assistant", content: tool_calls ? "thinking..." : "done", tool_calls };
}

// MCP stub for tests
interface McpStub {
  listToolSpecs: () => Promise<ToolSpec[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  waitForActivity: (args: { timeoutMs: number; since?: string }) => Promise<{ hasActivity: boolean; nextBatch: string }>;
}

function createMcpStub(params?: {
  readRoomResult?: string;
  sendMessageResult?: string;
  sendMessageError?: Error;
  waitForActivityResult?: { hasActivity: boolean; nextBatch: string };
}): McpStub {
  return {
    listToolSpecs: async () => [],
    callTool: async (name: string, _args: Record<string, unknown>): Promise<string> => {
      if (name === "matrix_read_room") {
        return params?.readRoomResult ?? JSON.stringify([]);
      }
      if (name === "matrix_send_message") {
        if (params?.sendMessageError) throw params.sendMessageError;
        return params?.sendMessageResult ?? JSON.stringify({ id: "event_1", createdAt: new Date().toISOString() });
      }
      throw new Error(`unexpected tool: ${name}`);
    },
    waitForActivity: async (_args: { timeoutMs: number; since?: string }) =>
      params?.waitForActivityResult ?? { hasActivity: false, nextBatch: "s1" },
  };
}

describe("ModeratorRuntime", () => {
  describe("classification branching", () => {
    test("ACTIVE classification: continues loop, does not post", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [
        assistant([classifyCall("active", "Discussion is ongoing with new points")]),
        assistant(), // Final message with no tool calls to end the turn
      ];

      const mcp = createMcpStub();
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      expect(result.classification).toBe("active");
      expect(result.shouldEnd).toBe(false);

      // Read the event log to verify no message was posted.
      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      // Should have: heartbeat (active), classification (active).
      // Must NOT have a message event.
      const messageEvents = events.filter((e) => e.type === "message");
      expect(messageEvents).toHaveLength(0);
    });

    test("STALE classification: posts closing message and signals end", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      const closingMessage = "The discussion has exhausted its points and is now repeating. Time to conclude.";
      script = [
        assistant([classifyCall("stale", "Arguments are now repeating without new additions")]),
        assistant([sendCall(closingMessage)]),
        assistant(), // Final message to end the turn
      ];

      const mcp = createMcpStub({
        sendMessageResult: JSON.stringify({ id: "event_msg_1", createdAt: new Date().toISOString() }),
      });
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      expect(result.classification).toBe("stale");
      expect(result.shouldEnd).toBe(true);

      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      // Verify the closing message event and the moderator_ended_run event exist.
      const messageEvent = events.find((e) => e.type === "message" && e.agentId === "moderator");
      expect(messageEvent).toBeDefined();
      expect(messageEvent?.content).toBe(closingMessage);

      const endEvent = events.find((e) => e.type === "moderator_ended_run");
      expect(endEvent).toBeDefined();
      expect(endEvent?.messageId).toBe("event_msg_1");
    });
  });

  describe("silence invariant", () => {
    test("ACTIVE classification with send attempt: message is rejected", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [
        assistant([classifyCall("active", "Discussion is ongoing")]),
        assistant([sendCall("This should not be allowed")]),
        assistant(), // Final message to end the turn
      ];

      const mcp = createMcpStub();
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      expect(result.shouldEnd).toBe(false);

      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      // The message should never reach the Matrix layer or event log.
      const messageEvents = events.filter((e) => e.type === "message");
      expect(messageEvents).toHaveLength(0);
    });

    test("classification must be called before any send attempt", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      // Script a message send without first classifying: the model should
      // not be able to skip classification and jump straight to posting.
      // However, since we can't prevent the model from attempting it,
      // we test that the runtime catches it.
      script = [
        assistant([sendCall("Attempting to post without classifying")]),
        assistant([classifyCall("stale", "Just classified after attempting send")]),
        assistant([sendCall("Now trying to post after STALE")]),
        assistant(), // Final message to end the turn
      ];

      const mcp = createMcpStub({
        sendMessageResult: JSON.stringify({ id: "event_final", createdAt: new Date().toISOString() }),
      });
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      // The turn should complete; the first send (before classification) was rejected,
      // but the second send (after STALE) should succeed.
      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      // Should have exactly one message event (the one posted after STALE).
      const messageEvents = events.filter((e) => e.type === "message");
      expect(messageEvents).toHaveLength(1);
    });
  });

  describe("disagreement and conflict handling", () => {
    test("conflict/hostility in room content is classified ACTIVE", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [
        assistant([classifyCall("active", "Heated disagreement indicates strong engagement despite tension")]),
        assistant(), // Final message to end the turn
      ];

      const mcp = createMcpStub();
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      expect(result.classification).toBe("active");
      expect(result.shouldEnd).toBe(false);
    });

    test("repetitive static positions are classified STALE", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [
        assistant([
          classifyCall(
            "stale",
            "Both participants have repeated their positions verbatim three times with no new supporting evidence"
          ),
        ]),
        assistant([sendCall("The discussion has reached an impasse. Time to wrap up.")]),
        assistant(), // Final message to end the turn
      ];

      const mcp = createMcpStub({
        sendMessageResult: JSON.stringify({ id: "event_end", createdAt: new Date().toISOString() }),
      });
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      expect(result.classification).toBe("stale");
      expect(result.shouldEnd).toBe(true);
    });
  });

  describe("runLoop", () => {
    test("loop continues on ACTIVE, exits on STALE", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      let loopIterations = 0;
      const mcp = createMcpStub({
        waitForActivityResult: { hasActivity: true, nextBatch: "s_next" },
      });

      script = [
        assistant([classifyCall("active", "Still going")]),
        assistant([classifyCall("stale", "Now stale")]),
        assistant([sendCall("Done.")]),
      ];

      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        isStopped: () => {
          // Fail-safe: if the loop doesn't exit after 3 iterations, force stop.
          loopIterations++;
          return loopIterations > 2;
        },
      });

      // Override waitForActivity to track calls
      let waitCalls = 0;
      const originalWait = mcp.waitForActivity;
      mcp.waitForActivity = async (args) => {
        waitCalls++;
        return originalWait(args);
      };

      // Also override the send to return a valid event.
      const originalCall = mcp.callTool;
      mcp.callTool = async (name, args) => {
        if (name === "matrix_send_message") {
          return JSON.stringify({ id: "event_end", createdAt: new Date().toISOString() });
        }
        return originalCall(name, args);
      };

      await runtime.runLoop();

      // Should have looped twice: once for ACTIVE, once for STALE+send.
      expect(waitCalls).toBe(2);
    });

    /**
     * Drives runLoop against a scripted sequence of polls on a fake clock, so
     * quiet-room timing is tested without sleeping. Each poll advances the clock
     * by its own duration (a full 30s wait, or less when /sync returns early).
     */
    async function runQuietLoop(params: {
      polls: Array<{ activity: boolean; durationMs: number }>;
      quietReassessAfterMs: number;
    }) {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      llmCalls = [];
      let clock = 1_000_000;
      let waitCalls = 0;
      const mcp = createMcpStub();
      mcp.waitForActivity = async () => {
        const poll = params.polls[waitCalls] ?? { activity: false, durationMs: 30_000 };
        waitCalls++;
        clock += poll.durationMs;
        return { hasActivity: poll.activity, nextBatch: `s${waitCalls}` };
      };
      let iterations = 0;
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 30_000,
        quietReassessAfterMs: params.quietReassessAfterMs,
        now: () => clock,
        // Fail-safe so a regression hangs nothing: every scripted case ends the
        // Run well before this.
        isStopped: () => ++iterations > params.polls.length,
      });
      await runtime.runLoop();
      const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const turnMessages = llmCalls
        .map((call) => call.find((m) => m.role === "user")?.content ?? "")
        // A turn's tool-calling steps repeat its turn message; keep one per turn.
        .filter((msg, i, all) => i === 0 || msg !== all[i - 1]);
      return { waitCalls, events, turnMessages };
    }

    const quiet = { activity: false, durationMs: 30_000 };
    const active = { activity: true, durationMs: 5_000 };

    test("a silent room is reassessed and can be ended STALE", async () => {
      script = [
        assistant([classifyCall("stale", "Nobody has posted for a while; the discussion has trailed off")]),
        assistant([sendCall("The discussion has gone quiet. Closing the Run.")]),
        assistant(),
      ];

      const { waitCalls, events, turnMessages } = await runQuietLoop({
        polls: [quiet, quiet, quiet],
        quietReassessAfterMs: 60_000,
      });

      // Reassessed once a minute of silence had passed, and that turn ended the Run.
      expect(waitCalls).toBe(2);
      expect(events.find((e) => e.type === "moderator_ended_run")).toBeDefined();
      expect(turnMessages[0]).toMatch(/quiet.*60 seconds/);
    });

    test("activity resets the quiet clock", async () => {
      script = [
        assistant([classifyCall("active", "New post just arrived")]),
        assistant(),
        assistant([classifyCall("stale", "Quiet since the last post")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];

      // 60s of quiet does not reach the 90s threshold before activity arrives;
      // that quiet must not carry over, so the next quiet turn comes only after
      // three fresh quiet polls.
      const { waitCalls, events } = await runQuietLoop({
        polls: [quiet, quiet, active, quiet, quiet, quiet],
        quietReassessAfterMs: 90_000,
      });

      expect(waitCalls).toBe(6);
      const classifications = events
        .filter((e) => e.type === "moderator_classification")
        .map((e) => e.classification);
      expect(classifications).toEqual(["active", "stale"]);
    });

    test("a pause judged ACTIVE is reassessed later with the full quiet time", async () => {
      script = [
        assistant([classifyCall("active", "Probably just a pause")]),
        assistant(),
        assistant([classifyCall("stale", "Two minutes without a post")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];

      const { turnMessages } = await runQuietLoop({
        polls: [quiet, quiet, quiet, quiet],
        quietReassessAfterMs: 60_000,
      });

      // The second quiet turn reports the whole silence, not just the time since
      // the first quiet turn, so a lasting silence reads as lasting.
      expect(turnMessages).toHaveLength(2);
      expect(turnMessages[0]).toMatch(/60 seconds/);
      expect(turnMessages[1]).toMatch(/120 seconds/);
    });

    test("empty polls that return early do not trigger a reassessment too soon", async () => {
      script = [
        assistant([classifyCall("stale", "Quiet for a minute")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];

      // /sync can come back empty after a second (presence, typing, receipts).
      // Six of those are 6s of silence, not three minutes.
      const early = { activity: false, durationMs: 1_000 };
      const { waitCalls, turnMessages } = await runQuietLoop({
        polls: [early, early, early, early, early, early, quiet, quiet],
        quietReassessAfterMs: 60_000,
      });

      expect(waitCalls).toBe(8);
      expect(turnMessages[0]).toMatch(/66 seconds/);
    });
  });

  describe("turn message", () => {
    test("the first Assessment says the discussion has just started and counts the room", () => {
      const msg = buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: 1, newMessages: 0 });
      expect(msg).toContain("first assessment");
      expect(msg).toContain("just started");
      expect(msg).toContain("The room holds 1 message so far.");
      expect(msg).not.toMatch(/no new messages/i);
    });

    test("the first Assessment pluralises the count and copes with an uncounted room", () => {
      expect(buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: 3, newMessages: 0 })).toContain(
        "The room holds 3 messages so far.",
      );
      const uncounted = buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: null, newMessages: 0 });
      expect(uncounted).toContain("first assessment");
      expect(uncounted).not.toMatch(/no new messages/i);
    });

    test("a later Assessment reports the new messages since the previous one", () => {
      expect(buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 5, newMessages: 2 })).toContain(
        "2 new messages since your last assessment.",
      );
      expect(buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 5, newMessages: 1 })).toContain(
        "1 new message since your last assessment.",
      );
    });

    test("a later Assessment woken by activity is never told there are no new messages", () => {
      // The count can stay put when the room cannot be counted or is past the read limit.
      const msg = buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 100, newMessages: 0 });
      expect(msg).not.toMatch(/no new messages/i);
      expect(msg).toContain("new activity");
    });

    test("a quiet-room reassessment reports the silence duration", () => {
      const msg = buildModeratorTurnMessage({
        isFirstAssessment: false,
        messageCount: 4,
        newMessages: 0,
        quietForMs: 90_000,
      });
      expect(msg).toMatch(/quiet.*90 seconds/);
    });

    test("runTurn tells the first Assessment the room's count and later ones what is new", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      llmCalls = [];
      let room = [{ body: "Seed" }];
      const mcp = createMcpStub();
      mcp.callTool = async () => JSON.stringify(room);
      script = [
        assistant([classifyCall("active", "Just begun")]),
        assistant(),
        assistant([classifyCall("active", "Replies coming in")]),
        assistant(),
      ];
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
      });

      await runtime.runTurn();
      room = [...room, { body: "a" }, { body: "b" }];
      await runtime.runTurn();

      const turnMessages = llmCalls.map((call) => call.find((m) => m.role === "user")?.content ?? "");
      expect(turnMessages[0]).toContain("first assessment");
      expect(turnMessages[0]).toContain("The room holds 1 message so far.");
      expect(turnMessages[2]).toContain("2 new messages since your last assessment.");
    });
  });
});
