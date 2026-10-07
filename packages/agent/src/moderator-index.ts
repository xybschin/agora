import { loadModeratorEnvConfig } from "./moderator-config.js";
import { MatrixMcpClient } from "./mcpClient.js";
import { ModeratorRuntime } from "./moderator.js";

const env = loadModeratorEnvConfig();
const mcp = new MatrixMcpClient(env.mcpUrl, env.matrixAccessToken);

const runtime = new ModeratorRuntime({
  runId: env.runId,
  roomId: env.roomId,
  matrixSetupUserId: env.matrixSetupUserId,
  logDir: env.logDir,
  mcp,
  llm: env.llm,
});

console.log(`moderator starting for run ${env.runId}`);

// Run the moderator's event-driven loop. This returns when the Moderator
// ends the Run (classifies the discussion STALE and posts the closing message),
// or when the process is terminated.
runtime.runLoop().catch((err) => {
  // A hard failure of the loop itself is fatal: the moderator's half of the Run
  // would go silent, so exit and let the Run's supervision record the gap.
  console.error("[moderator] moderator loop exited fatally:", err);
  process.exit(1);
});
