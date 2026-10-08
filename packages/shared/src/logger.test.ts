import { describe, expect, spyOn, test } from "bun:test";
import { createLogger, formatLogLine } from "./logger.js";

const at = new Date("2026-10-08T09:37:12.345Z");

describe("formatLogLine", () => {
  test("writes timestamp, padded level, scope and message", () => {
    expect(formatLogLine(at, "info", "runner", "Starting run x")).toBe(
      "2026-10-08T09:37:12.345Z INFO  [runner] Starting run x",
    );
    expect(formatLogLine(at, "error", "llm", "request failed")).toBe(
      "2026-10-08T09:37:12.345Z ERROR [llm] request failed",
    );
  });

  test("appends details: strings as is, objects as JSON, errors as their stack", () => {
    const err = new Error("boom");
    const line = formatLogLine(at, "warn", "agent-a", "turn 1 failed:", ["raw", { n: 1 }, err]);
    expect(line).toBe(`2026-10-08T09:37:12.345Z WARN  [agent-a] turn 1 failed: raw {"n":1} ${err.stack}`);
  });
});

describe("createLogger", () => {
  test("sends info to console.log and warn/error to console.warn/console.error", () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const log = createLogger("runner");
      log.info("a");
      log.warn("b");
      log.error("c");
      expect(String(out.mock.calls[0]![0])).toEndWith("INFO  [runner] a");
      expect(String(warn.mock.calls[0]![0])).toEndWith("WARN  [runner] b");
      expect(String(err.mock.calls[0]![0])).toEndWith("ERROR [runner] c");
    } finally {
      out.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });
});
