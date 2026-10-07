import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";

// moderator.ts drives its tool loop through chatCompletion, so we mock
// that before importing the module. The mcp client is passed in as a stub.
// A scripted Error is thrown instead of answered, standing in for a provider
// failure that outlasted chatCompletion's own retries.
type ScriptedMessage = ChatMessage & { tool_calls?: ToolCall[] };

let script: Array<ScriptedMessage | Error> = [];
// The messages of every chatCompletion call, so a test can read the turn
// message the Moderator was given.
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

const { ModeratorRuntime } = await import("./moderator.js");

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

  describe("rationale requirement", () => {
    function classifyCallWithArgs(args: Record<string, unknown>): ToolCall {
      return {
        id: "call_classify",
        type: "function",
        function: { name: "classify_discussion", arguments: JSON.stringify(args) },
      };
    }

    function newRuntime(logDir: string) {
      return new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });
    }

    async function readEvents(logDir: string) {
      const content = await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8");
      return content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    }

    for (const [label, args] of [
      ["missing", { classification: "active" }],
      ["non-string", { classification: "active", rationale: 42 }],
      ["blank", { classification: "active", rationale: "   " }],
    ] as const) {
      test(`a ${label} rationale is rejected and the retried call is recorded`, async () => {
        const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
        llmCalls = [];
        script = [
          assistant([classifyCallWithArgs(args)]),
          assistant([classifyCall("active", "New points are still being raised")]),
          assistant(),
        ];

        const result = await newRuntime(logDir).runTurn();

        expect(result.classification).toBe("active");
        // The model was told why its first call failed.
        const toolReply = llmCalls[1]?.find((m) => m.role === "tool");
        expect(toolReply?.content).toContain("rationale");
        expect(toolReply?.content).not.toContain("classification recorded");

        const classifications = (await readEvents(logDir)).filter((e) => e.type === "moderator_classification");
        expect(classifications).toHaveLength(1);
        expect(classifications[0].rationale).toBe("New points are still being raised");
      });
    }

    test("a STALE classification without a rationale cannot end the Run", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      script = [
        assistant([classifyCallWithArgs({ classification: "stale", rationale: "" })]),
        assistant([sendCall("Thanks everyone, we are done here.")]),
        assistant(),
      ];

      const result = await newRuntime(logDir).runTurn();

      expect(result.classification).toBe("active");
      expect(result.shouldEnd).toBe(false);
      const events = await readEvents(logDir);
      expect(events.filter((e) => e.type === "moderator_classification")).toHaveLength(0);
      expect(events.filter((e) => e.type === "message")).toHaveLength(0);
      expect(events.filter((e) => e.type === "moderator_ended_run")).toHaveLength(0);
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
        assistant(),
        assistant([classifyCall("stale", "Now stale")]),
        assistant([sendCall("Done.")]),
        assistant(),
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
      turnRetry?: Record<string, unknown>;
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
        turnRetry: params.turnRetry,
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

    test("a failed Assessment is recorded and re-run after a backoff, without a new wake", async () => {
      // One activity wake: the first Assessment's LLM call throws (provider out
      // of capacity); the re-run classifies STALE and ends the Run without the
      // room having to say anything new.
      script = [
        new Error("429 No capacity available"),
        assistant([classifyCall("stale", "Over")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];
      const { turnRetry, sleeps } = fastTurnRetry(3);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { waitCalls, events } = await runQuietLoop({
          polls: [active],
          quietReassessAfterMs: 60_000,
          turnRetry,
        });

        expect(waitCalls).toBe(1);
        expect(sleeps).toEqual([1_000]);
        const failed = events.filter((e) => e.type === "agent_turn_failed");
        expect(failed).toEqual([
          expect.objectContaining({
            runId: RUN_ID,
            agentId: "moderator",
            turn: 1,
            error: "429 No capacity available",
            timestamp: expect.any(String),
          }),
        ]);
        expect(events.find((e) => e.type === "moderator_ended_run")).toBeDefined();

        const logged = errors.mock.calls.map((args) => String(args[0]));
        expect(logged.some((line) => line.includes("turn 1 failed"))).toBe(true);
        expect(logged.some((line) => line.includes("waiting for room activity failed"))).toBe(false);
      } finally {
        errors.mockRestore();
      }
    });

    test("Assessment retries are capped; past the cap the loop resumes waiting", async () => {
      // Two activity wakes: every attempt on the first wake fails, so the loop
      // gives up and waits; the second wake's Assessment ends the Run.
      script = [
        new Error("429 No capacity available"),
        new Error("429 No capacity available"),
        assistant([classifyCall("stale", "Over")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];
      const { turnRetry, sleeps } = fastTurnRetry(1);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { waitCalls, events } = await runQuietLoop({
          polls: [active, active],
          quietReassessAfterMs: 60_000,
          turnRetry,
        });

        expect(waitCalls).toBe(2);
        expect(sleeps).toEqual([1_000]);
        expect(events.filter((e) => e.type === "agent_turn_failed").map((e) => e.turn)).toEqual([1, 2]);
        expect(events.find((e) => e.type === "moderator_ended_run")).toBeDefined();
      } finally {
        errors.mockRestore();
      }
    });

    test("a failed Assessment that already posted its closing message is not re-run", async () => {
      // The closing message lands; the follow-up LLM call then fails. Re-running
      // would post a second closing message, so the loop goes back to waiting.
      script = [
        assistant([classifyCall("stale", "Over")]),
        assistant([sendCall("Closing.")]),
        new Error("503"),
      ];
      const { turnRetry, sleeps } = fastTurnRetry(3);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { events } = await runQuietLoop({
          polls: [active],
          quietReassessAfterMs: 60_000,
          turnRetry,
        });

        expect(events.filter((e) => e.type === "message")).toHaveLength(1);
        expect(events.filter((e) => e.type === "agent_turn_failed")).toHaveLength(1);
        expect(sleeps).toEqual([]);
      } finally {
        errors.mockRestore();
      }
    });

    test("a re-run Assessment still reports the room activity that woke it", async () => {
      // The first Assessment completes ACTIVE with 2 messages in the room. The
      // next wake finds 5; that Assessment fails, and its re-run must still be
      // told about the 3 new messages, not "No new messages" -- which would
      // nudge the model towards STALE while the room is active.
      script = [
        assistant([classifyCall("active", "Going")]),
        assistant(),
        new Error("429 No capacity available"),
        assistant([classifyCall("active", "Still going")]),
        assistant(),
      ];
      llmCalls = [];
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      const mcp = createMcpStub();
      let waitCalls = 0;
      const room = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `$m${i}` })));
      mcp.waitForActivity = async () => {
        waitCalls++;
        mcp.callTool = async () => room(waitCalls === 1 ? 2 : 5);
        return { hasActivity: true, nextBatch: `s${waitCalls}` };
      };
      const { turnRetry } = fastTurnRetry(3);
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        isStopped: () => waitCalls >= 2,
        turnRetry,
      });
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await runtime.runLoop();

        const turnMessages = llmCalls.map((call) => call.find((m) => m.role === "user")?.content ?? "");
        expect(turnMessages[2]).toMatch(/^3 new messages/);
        expect(turnMessages[3]).toMatch(/^3 new messages/);
      } finally {
        errors.mockRestore();
      }
    });

    test("a retried quiet-room reassessment is still told how long the room was quiet", async () => {
      script = [
        new Error("503"),
        assistant([classifyCall("stale", "Quiet")]),
        assistant([sendCall("Closing.")]),
        assistant(),
      ];
      const { turnRetry } = fastTurnRetry(3);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { events } = await runQuietLoop({
          polls: [quiet, quiet],
          quietReassessAfterMs: 60_000,
          turnRetry,
        });

        // The failed attempt and the re-run each got the quiet-room message.
        const userMessages = llmCalls.map((call) => call.find((m) => m.role === "user")?.content ?? "");
        expect(userMessages.length).toBeGreaterThanOrEqual(2);
        for (const msg of userMessages) expect(msg).toMatch(/60 seconds/);
        expect(events.find((e) => e.type === "moderator_ended_run")).toBeDefined();
      } finally {
        errors.mockRestore();
      }
    });

    test("a failed wait is not recorded as a failed Assessment", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      const mcp = createMcpStub();
      let waitCalls = 0;
      mcp.waitForActivity = async () => {
        waitCalls++;
        if (waitCalls === 1) throw new Error("dropped connection");
        return { hasActivity: false, nextBatch: "s2" };
      };
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        isStopped: () => waitCalls >= 2,
        waitBackoff: { sleep: async () => {} },
      });
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await runtime.runLoop();
        const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events.filter((e) => e.type === "agent_turn_failed")).toHaveLength(0);
        const logged = errors.mock.calls.map((args) => String(args[0]));
        expect(logged.some((line) => line.includes("waiting for room activity failed"))).toBe(true);
      } finally {
        errors.mockRestore();
      }
    });

    test("consecutive wait failures back off, growing to a cap, and a success resets it", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      const mcp = createMcpStub();
      const sinces: Array<string | undefined> = [];
      mcp.waitForActivity = async (args) => {
        sinces.push(args.since);
        const n = sinces.length;
        if (n <= 6) throw new Error("ConnectionRefused");
        if (n === 7) return { hasActivity: false, nextBatch: "s2" };
        if (n === 8) throw new Error("ConnectionRefused");
        return { hasActivity: false, nextBatch: "s3" };
      };
      const sleeps: number[] = [];
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        quietReassessAfterMs: Number.POSITIVE_INFINITY,
        isStopped: () => sinces.length >= 9,
        waitBackoff: {
          baseDelayMs: 250,
          maxDelayMs: 2_000,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      });
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await runtime.runLoop();
        const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 250]);
        expect(events.filter((e) => e.type === "agent_heartbeat")).toHaveLength(sinces.length);
        // The token only advances on a successful wait.
        expect(sinces).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, "s2", "s2"]);
      } finally {
        errors.mockRestore();
      }
    });
  });
});
