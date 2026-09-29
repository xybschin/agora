/**
 * Cumulative token-budget guardrail (Q21): the orchestrator aborts a run as
 * soon as this is exceeded, protecting against a misconfigured scenario or a
 * tool-calling loop that burns tokens unattended.
 */
export class BudgetTracker {
  private totalTokens = 0;

  constructor(private readonly maxTotalTokens?: number) {}

  record(usage: { promptTokens: number; completionTokens: number }): void {
    this.totalTokens += usage.promptTokens + usage.completionTokens;
  }

  isExceeded(): boolean {
    return this.maxTotalTokens !== undefined && this.totalTokens > this.maxTotalTokens;
  }

  summary(): { totalTokens: number; maxTotalTokens?: number } {
    return { totalTokens: this.totalTokens, maxTotalTokens: this.maxTotalTokens };
  }
}
