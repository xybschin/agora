import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SamplingParams } from "@agora/shared";

// chatCompletion builds its own OpenAI client internally, so to observe what
// it sends (and to make it fail with a provider-style error) the `openai`
// module is mocked at the top of this file, before ./llm.js is imported. The
// fake's create() delegates to a mutable `mockCreate` the tests set per case;
// OpenAI.APIError is faked too, so isUnsupportedParameterError's instanceof
// check sees a real (fake) API error.
let mockCreate: ((params: Record<string, unknown>) => unknown) | null = null;
// The faked openai class, captured so tests can throw its APIError without an
// await inside a non-async create callback.
let OpenAIMock: { new (): unknown; APIError: new (msg: string, status: number) => Error } | undefined;

mock.module("openai", () => {
  class FakeAPIError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class FakeOpenAI {
    static APIError = FakeAPIError;
    chat = {
      completions: {
        create: (params: Record<string, unknown>) => {
          if (!mockCreate) throw new Error("no mockCreate installed for this test");
          return mockCreate(params);
        },
      },
    };
  }
  OpenAIMock = FakeOpenAI;
  return { default: FakeOpenAI };
});

// Imported after mock.module so the fake openai is what llm.ts sees.
const { chatCompletion, resolveSamplingParams, temperatureFromAgentId } = await import("./llm.js");

function completion(params: Record<string, unknown>) {
  return {
    choices: [
      {
        message: { role: "assistant", content: "sure, I can go", tool_calls: null },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const BASE = { baseUrl: "http://test/v1", apiKey: "sk-test", model: "m" };

describe("temperatureFromAgentId", () => {
  test("is deterministic for the same agent", () => {
    expect(temperatureFromAgentId("alex")).toBe(temperatureFromAgentId("alex"));
  });

  test("differs across agents", () => {
    expect(temperatureFromAgentId("alex")).not.toBe(temperatureFromAgentId("bri"));
  });

  test("stays within the legal temperature range", () => {
    for (const id of ["alex", "bri", "casey", "devon", "eli", "zzz", "a-a-a-a"]) {
      const t = temperatureFromAgentId(id);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(2);
    }
  });
});

describe("resolveSamplingParams", () => {
  test("applies llm.ts defaults when nothing is configured", () => {
    const s = resolveSamplingParams("alex");
    expect(s.maxTokens).toBe(150);
    expect(s.frequencyPenalty).toBeCloseTo(0.4, 5);
    expect(s.presencePenalty).toBeCloseTo(0.4, 5);
    // The default temperature is per-agent, not a fixed number.
    expect(s.temperature).toBe(temperatureFromAgentId("alex"));
  });

  test("a merged sampling blob overrides the defaults", () => {
    // The runner folds Scenario + credential into one blob; this agent-side
    // resolve only fills defaults for whatever the blob leaves unset.
    const merged: SamplingParams = { maxTokens: 120, frequencyPenalty: 0.5, temperature: 1.1 };
    const s = resolveSamplingParams("alex", merged);
    expect(s.maxTokens).toBe(120);
    expect(s.frequencyPenalty).toBe(0.5);
    expect(s.temperature).toBe(1.1);
    // Unset fields still fall back.
    expect(s.presencePenalty).toBeCloseTo(0.4, 5);
  });

  test("a pinned temperature beats the agent-id default", () => {
    const s = resolveSamplingParams("alex", { temperature: 0.9 });
    expect(s.temperature).toBe(0.9);
    expect(s.temperature).not.toBe(temperatureFromAgentId("alex"));
  });
});

describe("chatCompletion parameter propagation", () => {
  beforeEach(() => {
    mockCreate = null;
  });

  test("sends the resolved sampling fields as max_tokens/frequency_penalty/presence_penalty/temperature", async () => {
    let seen: any = null;
    mockCreate = (params) => {
      seen = params;
      return completion(params);
    };

    const sampling = resolveSamplingParams("alex");
    const result = await chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/a`, sampling }, [], []);
    expect(result.message.content).toBe("sure, I can go");
    expect(seen?.max_tokens).toBe(sampling.maxTokens);
    expect(seen?.frequency_penalty).toBe(sampling.frequencyPenalty);
    expect(seen?.presence_penalty).toBe(sampling.presencePenalty);
    expect(seen?.temperature).toBe(sampling.temperature);
  });

  test("max_tokens enforces the brevity bound from the Scenario", async () => {
    let seen: any = null;
    mockCreate = (params) => {
      seen = params;
      return completion(params);
    };
    await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/b`, sampling: resolveSamplingParams("bri", { maxTokens: 90 }) },
      [],
      [],
    );
    expect(seen?.max_tokens).toBe(90);
  });

  test("omits sampling entirely when the config carries none", async () => {
    let seen: any = null;
    mockCreate = (params) => {
      seen = params;
      return completion(params);
    };
    await chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/c` }, [], []);
    expect(seen?.max_tokens).toBeUndefined();
    expect(seen?.frequency_penalty).toBeUndefined();
    expect(seen?.temperature).toBeUndefined();
  });
});

describe("chatCompletion fallback on unsupported parameters", () => {
  beforeEach(() => {
    mockCreate = null;
  });

  test("retries once without sampling when a provider rejects a parameter with a 400", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockCreate = (params) => {
      calls.push(params);
      if (calls.length === 1) {
        // A provider refusing a parameter it does not support is a 400 naming
        // the parameter; the faked APIError carries the status the fallback
        // keys off.
        throw new OpenAIMock!.APIError("'temperature' is not allowed for this model", 400);
      }
      return completion(params);
    };

    const sampling = resolveSamplingParams("alex");
    const result = await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/d`, sampling },
      [],
      [],
    );

    // The stripped retry must actually drop the sampling fields.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.max_tokens).toBeUndefined();
    expect(calls[1]?.temperature).toBeUndefined();
    expect(result.message.content).toBe("sure, I can go");
  });

  test("a non-parameter failure is surfaced, not retried", async () => {
    mockCreate = () => {
      throw new Error("connection refused");
    };
    const sampling = resolveSamplingParams("alex");
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/e`, sampling }, [], []),
    ).rejects.toThrow("Failed to reach LLM at");
  });
});
