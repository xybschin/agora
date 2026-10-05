import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";

// moderator.ts drives its tool loop through chatCompletion, so we mock
// that before importing the module. The mcp client is passed in as a stub.
type ScriptedMessage = ChatMessage & { tool_calls?: ToolCall[] };

let script: Array<ScriptedMessage> = [];

mock.module("./llm.js", () => ({
  chatCompletion: async () => {
    const next = script.shift();
    if (!next) throw new Error("test script exhausted: no more assistant messages");
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
        memoryWindowSize: 50,
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
  });
});
