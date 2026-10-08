/**
 * Records one LLM call's token spend as a `usage` event, the only thing the
 * runner's budget check (packages/runner/src/budget.ts) charges. Shared by the
 * agent loop (loop.ts) and the Moderator (moderator.ts) so every LLM call in a
 * Run is counted the same way, whoever made it.
 */
import { appendEvent } from "@agora/shared";
import type { ChatCompletionResult } from "./llm.js";

/**
 * Appends a `usage` event attributed to `agentId` ("moderator" for the
 * Moderator). Does nothing when the provider reported no usage for the call.
 */
export async function recordUsage(
  logDir: string,
  runId: string,
  agentId: string,
  usage: ChatCompletionResult["usage"],
): Promise<void> {
  if (!usage) return;
  await appendEvent(logDir, runId, {
    type: "usage",
    runId,
    agentId,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    timestamp: new Date().toISOString(),
  });
}
