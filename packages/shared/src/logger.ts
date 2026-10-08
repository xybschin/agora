/**
 * The one log-line format every Agora process writes, the runner CLI and the
 * agent, Moderator and MCP containers alike:
 *
 *   2026-10-08T09:37:12.345Z INFO  [runner] Starting run abortion-policy-...
 *
 * `info` goes to stdout, `warn` and `error` to stderr. Anything passed after
 * the message is appended to the same line: an Error as its stack, a string as
 * is, anything else as JSON. CLI usage text is not logging and stays on plain
 * console output.
 */
export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  // console is looked up per call, not captured, so a test's spyOn(console, ...)
  // still sees the line.
  const write = (level: LogLevel, message: string, details: unknown[]) => {
    const line = formatLogLine(new Date(), level, scope, message, details);
    if (level === "info") console.log(line);
    else if (level === "warn") console.warn(line);
    else console.error(line);
  };
  return {
    info: (message, ...details) => write("info", message, details),
    warn: (message, ...details) => write("warn", message, details),
    error: (message, ...details) => write("error", message, details),
  };
}

export function formatLogLine(
  at: Date,
  level: LogLevel,
  scope: string,
  message: string,
  details: unknown[] = [],
): string {
  const head = `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  return [head, ...details.map(formatDetail)].join(" ");
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}
