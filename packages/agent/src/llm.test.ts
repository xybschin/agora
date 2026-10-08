/**
 * Pins llm.ts's contract with providers: per-agent sampling is resolved and
 * actually sent, a provider that refuses a sampling parameter still gets a
 * stripped call, transient failures are retried with bounded backoff, and a
 * hanging provider cannot stall a Turn past the total deadline. Each of these
 * is a way a single flaky provider could otherwise stall or kill a Run.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SamplingParams } from "@agora/shared";

// chatCompletion builds its own OpenAI client internally, so to observe what
// it sends (and to make it fail with a provider-style error) the `openai`
// module is mocked at the top of this file, before ./llm.js is imported. The
// fake's create() delegates to a mutable `mockCreate` the tests set per case;
// OpenAI.APIError is faked too, so isUnsupportedParameterError's instanceof
// check sees a real (fake) API error.
let mockCreate: ((params: Record<string, unknown>, options?: { signal?: AbortSignal }) => unknown) | null = null;
// The faked openai class, captured so tests can throw its APIError without an
// await inside a non-async create callback.
let OpenAIMock:
  | {
      new (): unknown;
      APIError: new (msg: string, status: number | undefined) => Error;
      APIConnectionError: new (msg: string) => Error;
    }
  | undefined;

mock.module("openai", () => {
  class FakeAPIError extends Error {
    status: number | undefined;
    constructor(message: string, status: number | undefined) {
      super(message);
      this.status = status;
    }
  }
  // The real SDK's connection error is an APIError with no status.
  class FakeAPIConnectionError extends FakeAPIError {
    constructor(message: string) {
      super(message, undefined);
    }
  }
  class FakeOpenAI {
    static APIError = FakeAPIError;
    static APIConnectionError = FakeAPIConnectionError;
    chat = {
      completions: {
        create: (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          if (!mockCreate) throw new Error("no mockCreate installed for this test");
          return mockCreate(params, options);
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

  test("an unexpected non-API failure is surfaced, not retried", async () => {
    mockCreate = () => {
      throw new Error("connection refused");
    };
    const sampling = resolveSamplingParams("alex");
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/e`, sampling }, [], []),
    ).rejects.toThrow("Failed to reach LLM at");
  });
});

describe("chatCompletion retry on transient failures", () => {
  // Retry timing is injected: sleeps are recorded instead of awaited and
  // advance a fake clock, and the jitter source is pinned so delays are
  // deterministic.
  let sleeps: number[];
  let clock: number;
  const retry = (overrides: Record<string, unknown> = {}) => ({
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    ...overrides,
  });

  beforeEach(() => {
    mockCreate = null;
    sleeps = [];
    clock = 0;
  });

  test("recovers after a few 429s, backing off exponentially", async () => {
    let calls = 0;
    mockCreate = (params) => {
      calls++;
      if (calls <= 3) throw new OpenAIMock!.APIError("No capacity available for this instance class", 429);
      return completion(params);
    };

    const result = await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/r1` },
      [],
      [],
      retry({ baseDelayMs: 100, maxDelayMs: 10_000 }),
    );

    expect(result.message.content).toBe("sure, I can go");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  test("jitter scales each delay by the random source", async () => {
    let calls = 0;
    mockCreate = (params) => {
      calls++;
      if (calls <= 2) throw new OpenAIMock!.APIError("busy", 429);
      return completion(params);
    };
    await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/r2` },
      [],
      [],
      retry({ baseDelayMs: 100, random: () => 0.5 }),
    );
    expect(sleeps).toEqual([50, 100]);
  });

  test("5xx and connection errors are retried too", async () => {
    let calls = 0;
    mockCreate = (params) => {
      calls++;
      if (calls === 1) throw new OpenAIMock!.APIError("bad gateway", 502);
      if (calls === 2) throw new OpenAIMock!.APIConnectionError("Connection error.");
      return completion(params);
    };
    const result = await chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/r3` }, [], [], retry());
    expect(result.message.content).toBe("sure, I can go");
    expect(calls).toBe(3);
  });

  test("gives up after maxAttempts and throws with the provider's message", async () => {
    let calls = 0;
    mockCreate = () => {
      calls++;
      throw new OpenAIMock!.APIError("No capacity available for this instance class", 429);
    };
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/r4` }, [], [], retry({ maxAttempts: 4 })),
    ).rejects.toThrow("No capacity available for this instance class");
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  test("gives up once the next backoff would exceed the total wait budget", async () => {
    let calls = 0;
    mockCreate = () => {
      calls++;
      throw new OpenAIMock!.APIError("busy", 503);
    };
    // Delays would be 100, 200, 400, ...; a 350ms budget allows 100 + 200 only.
    await expect(
      chatCompletion(
        { ...BASE, baseUrl: `${BASE.baseUrl}/r5` },
        [],
        [],
        retry({ maxAttempts: 10, baseDelayMs: 100, maxTotalWaitMs: 350 }),
      ),
    ).rejects.toThrow("busy");
    expect(sleeps).toEqual([100, 200]);
    expect(calls).toBe(3);
  });

  test("each delay is capped at maxDelayMs", async () => {
    let calls = 0;
    mockCreate = (params) => {
      calls++;
      if (calls <= 4) throw new OpenAIMock!.APIError("busy", 429);
      return completion(params);
    };
    await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/r6` },
      [],
      [],
      retry({ baseDelayMs: 100, maxDelayMs: 250 }),
    );
    expect(sleeps).toEqual([100, 200, 250, 250]);
  });

  test("a 4xx other than 429 is not retried", async () => {
    let calls = 0;
    mockCreate = () => {
      calls++;
      throw new OpenAIMock!.APIError("invalid api key", 401);
    };
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/r7` }, [], [], retry()),
    ).rejects.toThrow("invalid api key");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a non-parameter 400 is not retried", async () => {
    let calls = 0;
    mockCreate = () => {
      calls++;
      throw new OpenAIMock!.APIError("messages: field required", 400);
    };
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/r8` }, [], [], retry()),
    ).rejects.toThrow("messages: field required");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("the sampling-stripped fallback call is itself retried on a 429", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockCreate = (params) => {
      calls.push(params);
      if (calls.length === 1) throw new OpenAIMock!.APIError("'temperature' is not allowed for this model", 400);
      if (calls.length === 2) throw new OpenAIMock!.APIError("busy", 429);
      return completion(params);
    };
    const result = await chatCompletion(
      { ...BASE, baseUrl: `${BASE.baseUrl}/r9`, sampling: resolveSamplingParams("alex") },
      [],
      [],
      retry(),
    );
    expect(result.message.content).toBe("sure, I can go");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.temperature).toBeUndefined();
    expect(sleeps).toHaveLength(1);
  });
});

describe("chatCompletion bound on a hanging provider", () => {
  // A provider that accepts the connection and never answers. These tests run
  // on the real clock with millisecond budgets, because the bound under test
  // is wall-clock time, not the sum of backoff sleeps.
  const hang = (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const fast = { baseDelayMs: 5, maxDelayMs: 5, random: () => 1 };

  beforeEach(() => {
    mockCreate = null;
  });

  test("a hung attempt is cut off after attemptTimeoutMs and retried", async () => {
    let calls = 0;
    mockCreate = (params, options) => {
      calls++;
      return calls === 1 ? hang(params, options) : completion(params);
    };
    const result = await chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/h1` }, [], [], {
      ...fast,
      attemptTimeoutMs: 20,
      maxTotalWaitMs: 1_000,
    });
    expect(result.message.content).toBe("sure, I can go");
    expect(calls).toBe(2);
  });

  test("the timed-out request is aborted, not left running", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    mockCreate = (params, options) => {
      signals.push(options?.signal);
      return signals.length === 1 ? hang(params, options) : completion(params);
    };
    await chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/h2` }, [], [], {
      ...fast,
      attemptTimeoutMs: 20,
      maxTotalWaitMs: 1_000,
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a provider that always hangs fails within maxTotalWaitMs", async () => {
    let calls = 0;
    mockCreate = (params, options) => {
      calls++;
      return hang(params, options);
    };
    const started = Date.now();
    await expect(
      chatCompletion({ ...BASE, baseUrl: `${BASE.baseUrl}/h3` }, [], [], {
        ...fast,
        maxAttempts: 100,
        attemptTimeoutMs: 30,
        maxTotalWaitMs: 150,
      }),
    ).rejects.toThrow("Failed to reach LLM at");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(400);
    expect(calls).toBeGreaterThan(1);
  });

  test("the sampling fallback shares the same deadline", async () => {
    let calls = 0;
    mockCreate = (params, options) => {
      calls++;
      if (calls === 1) throw new OpenAIMock!.APIError("'temperature' is not allowed for this model", 400);
      return hang(params, options);
    };
    const started = Date.now();
    await expect(
      chatCompletion(
        { ...BASE, baseUrl: `${BASE.baseUrl}/h4`, sampling: resolveSamplingParams("alex") },
        [],
        [],
        { ...fast, maxAttempts: 100, attemptTimeoutMs: 30, maxTotalWaitMs: 150 },
      ),
    ).rejects.toThrow("Failed to reach LLM at");
    expect(Date.now() - started).toBeLessThan(400);
    expect(calls).toBeGreaterThan(2);
  });
});
