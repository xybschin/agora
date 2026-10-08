/**
 * Entry point of the Moderator container (docker/moderator.Dockerfile): loads
 * the env config, connects to the shared MCP server as the setup account, and
 * runs ModeratorRuntime's loop until the Moderator ends the Run.
 */
import { createLogger } from "@agora/shared";
import { loadModeratorEnvConfig } from "./moderator-config.js";
import { MatrixMcpClient } from "./mcpClient.js";
import { ModeratorRuntime } from "./moderator.js";

const env = loadModeratorEnvConfig();
const mcp = new MatrixMcpClient(env.mcpUrl, env.matrixAccessToken);

const runtime = new ModeratorRuntime({
  runId: env.runId,
  topic: env.topic,
  roomId: env.roomId,
  logDir: env.logDir,
  roster: env.roster,
  mcp,
  llm: env.llm,
});

const log = createLogger("moderator");
log.info(`starting for run ${env.runId}`);

// Returns once the Moderator ends the Run (a STALE Assessment that posted the
// closing message); otherwise runs until the container is stopped.
runtime.runLoop().catch((err) => {
  // runLoop already absorbs failed waits and failed Assessments, so reaching
  // here means the loop itself broke (e.g. the event log is unwritable). Exit
  // rather than linger: the runner's moderator watch warns once the heartbeats
  // stop, and the Run can then end only on the wall-clock timeout or operator
  // cancellation.
  log.error("moderator loop exited fatally:", err);
  process.exit(1);
});
