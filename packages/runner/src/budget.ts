/**
 * Cumulative token-budget guardrail (Q21), protecting against a misconfigured
 * Scenario or a tool-calling loop that burns tokens unattended.
 *
 * `superviseRunToTerminal` feeds it every `usage` event it reads off the
 * transcript and reports `budget_exceeded`
 * on the first poll where it is over; `index.ts` then records `run_aborted`.
 * Because spend is only seen after the fact, a Run can overshoot by whatever
 * lands between two polls. Only spend recorded as `usage` events counts,
 * whoever wrote them: agents and the Moderator alike.
 */
export class BudgetTracker {
  /** `maxTotalTokens` counts prompt plus completion tokens; leaving it unset means no limit. */
  private totalTokens = 0;

  constructor(private readonly maxTotalTokens?: number) {}

  record(usage: { promptTokens: number; completionTokens: number }): void {
    this.totalTokens += usage.promptTokens + usage.completionTokens;
  }

  /** True once spend is strictly over the limit; never true without one. */
  isExceeded(): boolean {
    return this.maxTotalTokens !== undefined && this.totalTokens > this.maxTotalTokens;
  }

  summary(): { totalTokens: number; maxTotalTokens?: number } {
    return { totalTokens: this.totalTokens, maxTotalTokens: this.maxTotalTokens };
  }
}
