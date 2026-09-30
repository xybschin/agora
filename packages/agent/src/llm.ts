import OpenAI from "openai";
import type { SamplingParams } from "@agora/shared";

/**
 * OpenAI-compatible chat-completions client using the official SDK.
 * Works with any provider that speaks the OpenAI API format,
 * including OpenAI, OpenRouter, Ollama, and vLLM.
 *
 * Sampling (`config.sampling`) is applied to every call: a bounded
 * max_tokens, frequency/presence penalties to blunt echo-chamber repetition,
 * and a per-agent temperature so agents drift apart instead of converging
 * (mechanism F of the repetition investigation). The resolved values come from
 * `resolveSamplingParams`, i.e. defaults overridden by the Scenario's
 * `samplingParams` and then by the agent's own credential `sampling`.
 *
 * OpenRouter fallback: not every model on every provider accepts the full
 * sampling set -- a subset of OpenRouter models reject frequency/presence
 * penalties or temperature with a 400, and some local endpoints ignore
 * unknown params only after refusing them. Rather than let an unsupported
 * parameter kill a Run, `chatCompletion` treats a 400 naming an unknown or
 * unsupported parameter as "this provider can't take the sampling": it retries
 * once stripped of all sampling fields. Sampling is best-effort; a Run never
 * dies because a provider declined a penalty. If the stripped call still
 * fails, that genuine error is surfaced.
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

/** Sampling with every field resolved to a concrete value. */
export interface ResolvedSampling {
  maxTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  temperature: number;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Fully-resolved sampling; omit to send no sampling params to the provider. */
  sampling?: ResolvedSampling;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

// Defaults, applied only where neither the Scenario's samplingParams nor the
// agent's credential sampling set a value. ~150 tokens enforces brevity;
// ~0.4 penalties discourage repeating the group's own argument back at it.
//
// The 150-token cap is a deliberate brevity bound (mechanism F): it forces
// short chat messages instead of essays. Its trade-off is that very long
// outputs -- chiefly a tool-call whose JSON `arguments` exceed 150 tokens --
// get cut off. That is not silent corruption: loop.ts parses tool arguments
// defensively and degrades to { raw } on a parse failure (the tool then
// rejects the malformed call and the model can retry), so a truncated turn
// fails loudly rather than doing something wrong. Scenarios that need roomier
// replies can raise maxTokens via samplingParams.
const DEFAULT_MAX_TOKENS = 150;
const DEFAULT_FREQUENCY_PENALTY = 0.4;
const DEFAULT_PRESENCE_PENALTY = 0.4;

// Temperatures derived per agent live in this range: wide enough that agents
// develop distinct voices, narrow enough that none tips into incoherence.
const TEMPERATURE_MIN = 0.7;
const TEMPERATURE_MAX = 1.3;
const TEMPERATURE_SPAN = TEMPERATURE_MAX - TEMPERATURE_MIN;

/**
 * Deterministic stable hash of an agent id into a temperature in
 * [TEMPERATURE_MIN, TEMPERATURE_MAX]. The same agent always gets the same
 * temperature across Runs (its voice stays consistent); different agents get
 * different temperatures (they stop sounding like one model echoing itself).
 * FNV-1a over the id string -- no collision-prone modulo assumption, just a
 * spread. Not a security primitive; reproducibility is the only requirement.
 */
export function temperatureFromAgentId(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Map the unsigned hash into the range deterministically.
  const frac = (hash >>> 0) / 0xffffffff;
  return TEMPERATURE_MIN + frac * TEMPERATURE_SPAN;
}

/**
 * Resolves the sampling a call should use: take the merged Scenario/credential
 * values (the runner already folded credential-over-Scenario into the single
 * LLM_SAMPLING_JSON it passes down) and fill in llm.ts's defaults for anything
 * left unset. Temperature's default is the only agent-derived value --
 * `temperatureFromAgentId(agentId)` -- so a Scenario or credential that pins a
 * temperature wins over it. Precedence of sources lives in the runner
 * (composeGenerator), not here, so there is one owner of that rule.
 */
export function resolveSamplingParams(
  agentId: string,
  mergedSampling?: SamplingParams,
): ResolvedSampling {
  return {
    maxTokens: mergedSampling?.maxTokens ?? DEFAULT_MAX_TOKENS,
    frequencyPenalty: mergedSampling?.frequencyPenalty ?? DEFAULT_FREQUENCY_PENALTY,
    presencePenalty: mergedSampling?.presencePenalty ?? DEFAULT_PRESENCE_PENALTY,
    temperature: mergedSampling?.temperature ?? temperatureFromAgentId(agentId),
  };
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

// Non-streaming params: the agent awaits a full ChatCompletion (it reads
// .choices/.usage), so pinning the type keeps create()'s return type the
// non-streaming ChatCompletion instead of a Stream | ChatCompletion union.
type CreateParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

function applySampling(params: CreateParams, sampling?: ResolvedSampling): void {
  if (!sampling) return;
  params.max_tokens = sampling.maxTokens;
  params.frequency_penalty = sampling.frequencyPenalty;
  params.presence_penalty = sampling.presencePenalty;
  params.temperature = sampling.temperature;
}

/** Builds the shared create params (model/messages/tools), sampling optional. */
function buildCreateParams(
  client: OpenAI,
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  sampling?: ResolvedSampling,
): CreateParams {
  const params: CreateParams = {
    model: config.model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    tools: tools as OpenAI.Chat.ChatCompletionTool[],
    tool_choice: "auto",
  };
  applySampling(params, sampling);
  return params;
}

/**
 * True when the error is a 400 from a provider that refuses a parameter it
 * does not support -- which is not the provider being down, just a capability
 * gap. SDK API errors carry `.status`; anything else (network, 5xx, auth) is a
 * genuine failure we must not paper over.
 */
function isUnsupportedParameterError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (error.status !== 400) return false;
  const msg = String(error.message ?? "");
  // OpenAI / OpenRouter / vLLM messages differ ("Unrecognized request
  // argument", "'temperature' is not allowed", "Unknown parameter"), but all
  // name the offending parameter or say 'unrecognized'/'not allowed'/'unknown'.
  return /parameter|argument|temperature|penalty|max_tokens|unrecognized|unknown/i.test(msg);
}

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<ChatCompletionResult> {
  const client = getClient(config);

  console.error(`[LLM] Sending request to ${config.baseUrl}`, {
    model: config.model,
    messageCount: messages.length,
    toolCount: tools.length,
    sampling: config.sampling,
  });

  try {
    const response = await client.chat.completions.create(
      buildCreateParams(client, config, messages, tools, config.sampling),
    );

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
    // OpenRouter fallback: a provider that rejects a sampling parameter (most
    // commonly frequency_penalty/presence_penalty/max_tokens/temperature) must
    // not kill the Run. Retry once without any sampling, then surface if the
    // stripped call still fails. See the module docstring for the contract.
    if (isUnsupportedParameterError(error) && config.sampling) {
      console.error(
        `[LLM] Provider rejected sampling params (${error instanceof Error ? error.message : String(error)}); retrying without sampling`,
      );
      try {
        const response = await client.chat.completions.create(
          buildCreateParams(client, config, messages, tools, undefined),
        );
        const choice = response.choices[0];
        if (choice) {
          const message: ChatMessage = { role: choice.message.role as "assistant", content: choice.message.content };
          if (choice.message.tool_calls) {
            message.tool_calls = choice.message.tool_calls.map((tc: OpenAI.Chat.ChatCompletionMessageToolCall) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
          }
          return {
            message,
            usage: response.usage
              ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens }
              : undefined,
          };
        }
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error(`[LLM] Retry without sampling also failed: ${retryMsg}`);
      }
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[LLM] Request failed: ${errorMsg}`);
    throw new Error(`Failed to reach LLM at ${config.baseUrl}: ${errorMsg}`);
  }
}
