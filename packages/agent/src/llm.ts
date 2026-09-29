import OpenAI from "openai";

/**
 * OpenAI-compatible chat-completions client using the official SDK.
 * Works with any provider that speaks the OpenAI API format,
 * including OpenAI, OpenRouter, Ollama, and vLLM.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * OpenAI client is constructed once per process per endpoint and reused, not
 * rebuilt on every chatCompletion call. `client.chat.completions.create`
 * returns a fresh request each time, so the connection pool and any keep-alive
 * state survive across tool steps; a map keyed by endpoint keeps the hot path
 * allocation-free while staying correct if a process ever serves multiple.
 */
const clients = new Map<string, OpenAI>();

function getClient(config: LlmConfig): OpenAI {
  const baseURL = config.baseUrl.replace(/\/$/, "");
  const key = `${baseURL}|${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL, apiKey: config.apiKey });
    clients.set(key, client);
  }
  return client;
}

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<ChatCompletionResult> {
  const client = getClient(config);

  try {
    console.error(`[LLM] Sending request to ${config.baseUrl}`, {
      model: config.model,
      messageCount: messages.length,
      toolCount: tools.length,
    });

    const response = await client.chat.completions.create({
      model: config.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
    });

    console.error(`[LLM] Got response with ${response.choices.length} choice(s)`);

    const choice = response.choices[0];
    if (!choice) throw new Error("LLM response contained no choices");

    const message: ChatMessage = {
      role: choice.message.role as "assistant",
      content: choice.message.content,
    };

    if (choice.message.tool_calls) {
      message.tool_calls = choice.message.tool_calls.map((tc: OpenAI.Chat.ChatCompletionMessageToolCall) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return {
      message,
      usage: response.usage
        ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens }
        : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[LLM] Request failed: ${errorMsg}`);
    throw new Error(`Failed to reach LLM at ${config.baseUrl}: ${errorMsg}`);
  }
}
