// Pins the Moderator's contract: an Assessment posts only after a STALE
// verdict, and only a posted closing message ends the Run; every tool call and
// verdict lands in the event log; STALE is refused until every roster agent
// has spoken; and the loop reassesses a quiet room, retries failed
// Assessments without double-posting, and backs off failed waits. These are
// the only guards between a model's judgment and ending a Run early or never.
import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
// What each chatCompletion call reports as its token usage; undefined stands in
// for a provider that returns none.
const DEFAULT_LLM_USAGE = { promptTokens: 5, completionTokens: 5 };
let llmUsage: { promptTokens: number; completionTokens: number } | undefined = DEFAULT_LLM_USAGE;

mock.module("./llm.js", () => ({
  chatCompletion: async (_llm: unknown, messages: ChatMessage[]) => {
    llmCalls.push([...messages]);
    const next = script.shift();
    if (!next) throw new Error("test script exhausted: no more assistant messages");
    if (next instanceof Error) throw next;
    return { message: next, usage: llmUsage };
  },
}));

const { ModeratorRuntime, buildModeratorTurnMessage } = await import("./moderator.js");

const SETUP_USER_ID = "@moderator:example.com";
const ROOM_ID = "!test:example.com";
const RUN_ID = "test-run-1";
const TOPIC = "Should the speed limit change?";

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
        topic: TOPIC,
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

      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

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
        topic: TOPIC,
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
        topic: TOPIC,
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

      // The model cannot be stopped from trying to post before classifying, so
      // the runtime must reject that send and still accept the one after STALE.
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
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      const result = await runtime.runTurn();

      const eventsPath = path.join(logDir, RUN_ID, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      const messageEvents = events.filter((e) => e.type === "message");
      expect(messageEvents).toHaveLength(1);
    });
  });

  describe("tool-call log", () => {
    test("records each tool call of an Assessment in order, with a bounded result summary", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [
        assistant([readRoomCall()]),
        assistant([classifyCall("active", "Three fresh arguments")]),
        assistant(),
      ];

      const roomMessages = ["first argument", "second argument", "third argument"].map((content, i) => ({
        id: `$e${i}`,
        sender: "@agent:example.com",
        content,
      }));
      const mcp = createMcpStub({ readRoomResult: JSON.stringify(roomMessages) });
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      await runtime.runTurn();

      const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const toolCalls = events.filter((e) => e.type === "moderator_tool_call");

      expect(toolCalls.map((e) => e.tool)).toEqual(["matrix_read_room", "classify_discussion"]);
      expect(toolCalls[0].args).toEqual({ limit: 100 });
      expect(toolCalls[0].resultSummary).toBe("3 messages");
      expect(toolCalls[1].args).toEqual({ classification: "active", rationale: "Three fresh arguments" });
      expect(toolCalls[1].resultSummary).toBe("classification recorded: active");
      // The read is logged before the verdict it informed.
      const readSeq = toolCalls[0].seq;
      const classificationSeq = events.find((e) => e.type === "moderator_classification").seq;
      expect(readSeq).toBeLessThan(classificationSeq);
    });

    test("a rejected post is recorded with the rejection as its result", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));

      script = [assistant([sendCall("Too early")]), assistant()];

      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });

      await runtime.runTurn();

      const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const toolCalls = events.filter((e) => e.type === "moderator_tool_call");

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].tool).toBe("matrix_send_message");
      expect(toolCalls[0].args).toEqual({ content: "Too early" });
      expect(toolCalls[0].resultSummary).toMatch(/^ERROR: You can only post/);
      expect(toolCalls[0].resultSummary.length).toBeLessThanOrEqual(200);
    });
  });

  describe("usage", () => {
    async function runOneAssessment(): Promise<Array<Record<string, unknown>>> {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      script = [
        assistant([readRoomCall()]),
        assistant([classifyCall("active", "Fresh arguments")]),
        assistant(),
      ];
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });
      await runtime.runTurn();
      return (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    }

    test("each LLM call of an Assessment records a usage event attributed to the Moderator", async () => {
      llmUsage = { promptTokens: 120, completionTokens: 30 };
      try {
        const events = await runOneAssessment();
        const usage = events.filter((e) => e.type === "usage");

        // Three scripted replies, three calls, three usage events.
        expect(usage).toHaveLength(3);
        for (const event of usage) {
          expect(event).toMatchObject({
            runId: RUN_ID,
            agentId: "moderator",
            promptTokens: 120,
            completionTokens: 30,
          });
        }
      } finally {
        llmUsage = DEFAULT_LLM_USAGE;
      }
    });

    test("a call whose provider reports no usage records no usage event", async () => {
      llmUsage = undefined;
      try {
        const events = await runOneAssessment();
        expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
      } finally {
        llmUsage = DEFAULT_LLM_USAGE;
      }
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
        topic: TOPIC,
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

  // The model is scripted, so these pin only that the runtime acts on the
  // verdict it is given, not that a real model judges conflict as ACTIVE.
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
        topic: TOPIC,
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
        topic: TOPIC,
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
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        isStopped: () => {
          // Fail-safe: stop before a third iteration if the loop has not exited.
          loopIterations++;
          return loopIterations > 2;
        },
      });

      let waitCalls = 0;
      const originalWait = mcp.waitForActivity;
      mcp.waitForActivity = async (args) => {
        waitCalls++;
        return originalWait(args);
      };

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
        topic: TOPIC,
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
        topic: TOPIC,
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
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: mcp as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
        isStopped: () => waitCalls >= 2,
        waitBackoff: { sleep: async () => {} },
      });
      const warnings = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await runtime.runLoop();
        const events = (await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events.filter((e) => e.type === "agent_turn_failed")).toHaveLength(0);
        const logged = warnings.mock.calls.map((args) => String(args[0]));
        expect(logged.some((line) => line.includes("waiting for room activity failed"))).toBe(true);
      } finally {
        warnings.mockRestore();
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
        topic: TOPIC,
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

  describe("system prompt", () => {
    test("names the Scenario's topic so the Moderator can judge what is on-topic", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      llmCalls = [];
      script = [assistant([classifyCall("active", "Agents are still trading new arguments")]), assistant()];

      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
      });
      await runtime.runTurn();

      const systemPrompt = llmCalls[0]?.find((m) => m.role === "system")?.content ?? "";
      expect(systemPrompt).toContain(TOPIC);
    });
  });

  describe("turn message", () => {
    test("the first Assessment says the discussion has just started and counts the room", () => {
      const msg = buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: 1, newMessages: 0, midTurn: [] });
      expect(msg).toContain("first assessment");
      expect(msg).toContain("just started");
      expect(msg).toContain("The room holds 1 message so far.");
      expect(msg).not.toMatch(/no new messages/i);
    });

    test("the first Assessment pluralises the count and copes with an uncounted room", () => {
      expect(buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: 3, newMessages: 0, midTurn: [] })).toContain(
        "The room holds 3 messages so far.",
      );
      const uncounted = buildModeratorTurnMessage({ isFirstAssessment: true, messageCount: null, newMessages: 0, midTurn: [] });
      expect(uncounted).toContain("first assessment");
      expect(uncounted).not.toMatch(/no new messages/i);
    });

    test("a later Assessment reports the new messages since the previous one", () => {
      expect(buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 5, newMessages: 2, midTurn: [] })).toContain(
        "2 new messages since your last assessment.",
      );
      expect(buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 5, newMessages: 1, midTurn: [] })).toContain(
        "1 new message since your last assessment.",
      );
    });

    test("a later Assessment woken by activity is never told there are no new messages", () => {
      // The count can stay put when the room cannot be counted or is past the read limit.
      const msg = buildModeratorTurnMessage({ isFirstAssessment: false, messageCount: 100, newMessages: 0, midTurn: [] });
      expect(msg).not.toMatch(/no new messages/i);
      expect(msg).toContain("new activity");
    });

    test("a quiet-room reassessment reports the silence duration", () => {
      const msg = buildModeratorTurnMessage({
        isFirstAssessment: false,
        messageCount: 4,
        newMessages: 0,
        quietForMs: 90_000,
        midTurn: [],
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
        topic: TOPIC,
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

  describe("agents mid-turn", () => {
    const roster = [
      { agentId: "alex", matrixUserId: "@agora-alex:example.com" },
      { agentId: "bri", matrixUserId: "@agora-bri:example.com" },
      { agentId: "cam", matrixUserId: "@agora-cam:example.com" },
    ];

    test("the turn message names the agents mid-turn and for how long", () => {
      const msg = buildModeratorTurnMessage({
        isFirstAssessment: false,
        messageCount: 5,
        newMessages: 2,
        midTurn: [{ agentId: "alex", forMs: 12_000 }, { agentId: "bri" }],
      });
      expect(msg).toContain("2 new messages since your last assessment.");
      expect(msg).toContain("2 agents are mid-turn");
      expect(msg).toContain("alex (for 12s), bri.");
    });

    test("the turn message says when nobody is mid-turn, or that it is unknown", () => {
      const base = { isFirstAssessment: true, messageCount: 1, newMessages: 0 };
      expect(buildModeratorTurnMessage({ ...base, midTurn: [] })).toContain("No agent is mid-turn right now.");
      expect(buildModeratorTurnMessage({ ...base, midTurn: null })).toContain("could not be determined");
    });

    test("a quiet-room reassessment while agents are mid-turn says the silence may be replies being composed", () => {
      const msg = buildModeratorTurnMessage({
        isFirstAssessment: false,
        messageCount: 4,
        newMessages: 0,
        quietForMs: 90_000,
        midTurn: [{ agentId: "alex", forMs: 20_000 }],
      });
      expect(msg).toMatch(/quiet.*90 seconds/);
      expect(msg).toContain("1 agent is mid-turn");
      expect(msg).toContain("alex (for 20s)");
      expect(msg).toMatch(/still being composed/);
    });

    test("runTurn tells the Assessment which roster agents have a turn open in the event log", async () => {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      const at = new Date().toISOString();
      const lines = [
        { type: "agent_turn_started", agentId: "alex", turn: 1 }, // open
        { type: "agent_turn_started", agentId: "bri", turn: 1 },
        { type: "agent_turn_ended", agentId: "bri", turn: 1 }, // ended
        { type: "agent_turn_started", agentId: "cam", turn: 1 },
        { type: "agent_turn_failed", agentId: "cam", turn: 1, error: "LLM out of capacity" }, // failed
        { type: "agent_turn_started", agentId: "stranger", turn: 1 }, // not on the roster
      ].map((event) => JSON.stringify({ runId: RUN_ID, seq: 1, timestamp: at, ...event }));
      await mkdir(path.join(logDir, RUN_ID), { recursive: true });
      await writeFile(path.join(logDir, RUN_ID, "events.jsonl"), lines.join("\n") + "\n");

      llmCalls = [];
      script = [assistant([classifyCall("active", "Replies are on their way")]), assistant()];
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        roster,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
      });
      await runtime.runTurn({ quietForMs: 60_000 });

      const turnMessage = String(llmCalls[0]!.find((m) => m.role === "user")?.content ?? "");
      expect(turnMessage).toContain("1 agent is mid-turn");
      expect(turnMessage).toMatch(/alex \(for \d+s\)/);
      expect(turnMessage).not.toContain("bri");
      expect(turnMessage).not.toContain("cam");
      expect(turnMessage).not.toContain("stranger");
      expect(turnMessage).toMatch(/still being composed/);
    });
  });

  describe("earlier Assessments", () => {
    async function newRuntime(now: () => number) {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      return new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        mcp: createMcpStub() as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        now,
      });
    }

    function systemPromptOf(call: ChatMessage[]): string {
      return String(call.find((m) => m.role === "system")?.content ?? "");
    }

    test("the first Assessment claims no earlier Assessments", async () => {
      llmCalls = [];
      script = [assistant([classifyCall("active", "Opening arguments are coming in")]), assistant()];

      await (await newRuntime(() => 0)).runTurn();

      const prompt = systemPromptOf(llmCalls[0]!);
      expect(prompt).toMatch(/first assessment/i);
      expect(prompt).not.toMatch(/conversation history/i);
    });

    test("a second Assessment sees the first one's verdict, rationale and age", async () => {
      llmCalls = [];
      let clock = 0;
      script = [
        assistant([classifyCall("active", "Ada and Ben are still trading new arguments")]),
        assistant(),
        assistant([classifyCall("active", "Still moving")]),
        assistant(),
      ];

      const runtime = await newRuntime(() => clock);
      await runtime.runTurn();
      clock = 45_000;
      await runtime.runTurn();

      const prompt = systemPromptOf(llmCalls[2]!);
      expect(prompt).toContain("ACTIVE");
      expect(prompt).toContain("Ada and Ben are still trading new arguments");
      expect(prompt).toMatch(/45 seconds ago/);
      expect(prompt).not.toMatch(/conversation history/i);
    });

    test("only a recent window of earlier Assessments is carried", async () => {
      llmCalls = [];
      script = [];
      for (let i = 1; i <= 7; i++) {
        script.push(assistant([classifyCall("active", `rationale number ${i}.`)]), assistant());
      }

      const runtime = await newRuntime(() => 0);
      for (let i = 1; i <= 7; i++) await runtime.runTurn();

      // The seventh Assessment's prompt carries the five before it, not the oldest.
      const prompt = systemPromptOf(llmCalls[12]!);
      expect(prompt).not.toContain("rationale number 1.");
      for (let i = 2; i <= 6; i++) expect(prompt).toContain(`rationale number ${i}.`);
      expect(prompt).not.toContain("rationale number 7.");
    });

    test("a turn that never classified leaves no Assessment behind", async () => {
      llmCalls = [];
      script = [assistant(), assistant([classifyCall("active", "Now classified")]), assistant()];

      const runtime = await newRuntime(() => 0);
      await runtime.runTurn();
      await runtime.runTurn();

      expect(systemPromptOf(llmCalls[1]!)).toMatch(/first assessment/i);
    });
  });

  describe("STALE before every agent has spoken", () => {
    const roster = [
      { agentId: "alex", matrixUserId: "@agora-alex:example.com" },
      { agentId: "bri", matrixUserId: "@agora-bri:example.com" },
    ];

    function roomWith(senders: string[]): string {
      return JSON.stringify(
        senders.map((sender, i) => ({
          eventId: `$e${i}`,
          sender,
          senderDisplayName: sender,
          content: sender === SETUP_USER_ID ? "**your message:** The floor is yours." : `post ${i}`,
          createdAt: new Date().toISOString(),
        })),
      );
    }

    async function readEvents(logDir: string): Promise<Array<Record<string, unknown>>> {
      const content = await readFile(path.join(logDir, RUN_ID, "events.jsonl"), "utf-8");
      return content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    async function runStaleTurn(readRoomResult: string) {
      const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
      script = [
        assistant([classifyCall("stale", "Nothing new is being said")]),
        assistant([sendCall("Closing the discussion.")]),
        assistant(),
      ];
      llmCalls = [];
      const runtime = new ModeratorRuntime({
        runId: RUN_ID,
        topic: TOPIC,
        roomId: ROOM_ID,
        matrixSetupUserId: SETUP_USER_ID,
        logDir,
        roster,
        mcp: createMcpStub({ readRoomResult }) as never,
        llm: { baseUrl: "http://localhost", apiKey: "test", model: "test" },
        waitTimeoutMs: 100,
      });
      const result = await runtime.runTurn();
      return { result, events: await readEvents(logDir) };
    }

    test("is refused, naming the silent agents, and recorded as ACTIVE", async () => {
      // Only the setup account (not in the roster) and alex have posted; bri's
      // reaction is not a post.
      const room = JSON.parse(roomWith([SETUP_USER_ID, "@agora-alex:example.com"])) as unknown[];
      room.push({
        eventId: "$r",
        sender: "@agora-bri:example.com",
        senderDisplayName: "bri",
        content: "[reaction] 👍",
        createdAt: new Date().toISOString(),
      });
      const { result, events } = await runStaleTurn(JSON.stringify(room));

      expect(result).toEqual({ classification: "active", shouldEnd: false });

      // The model is told who has not spoken yet.
      const classifyResult = llmCalls[1]!.find(
        (m) => m.role === "tool" && m.name === "classify_discussion",
      );
      expect(classifyResult?.content).toContain("bri");
      expect(classifyResult?.content).not.toContain("alex");

      const classifications = events.filter((e) => e.type === "moderator_classification");
      expect(classifications.map((e) => e.classification)).toEqual(["active"]);
      expect(events.some((e) => e.type === "message")).toBe(false);
      expect(events.some((e) => e.type === "moderator_ended_run")).toBe(false);
    });

    test("is accepted once every agent has posted, and the Run ends", async () => {
      const { result, events } = await runStaleTurn(
        roomWith([SETUP_USER_ID, "@agora-alex:example.com", "@agora-bri:example.com"]),
      );

      expect(result).toEqual({ classification: "stale", shouldEnd: true });
      const classifications = events.filter((e) => e.type === "moderator_classification");
      expect(classifications.map((e) => e.classification)).toEqual(["stale"]);
      expect(events.some((e) => e.type === "moderator_ended_run")).toBe(true);
    });
  });
});
