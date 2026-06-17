// Accumulates cost + token usage for the running status line and the end-of-session
// summary. Exposed as a shared singleton so the main loop AND ingestion's nested
// queries (which run outside the main message stream) accrue into one total.

export class CostMeter {
  totalUsd = 0;
  turns = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;

  // Add a main-loop ResultMessage.
  add(result: any): void {
    if (typeof result?.total_cost_usd === "number") this.totalUsd += result.total_cost_usd;
    this.turns += 1;
    const u = result?.usage ?? {};
    this.inputTokens += u.input_tokens ?? 0;
    this.outputTokens += u.output_tokens ?? 0;
    this.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  }

  // Add cost incurred outside the main loop (ingestion's nested draft/prober/synth
  // queries), so the displayed total reflects the full spend.
  addUsd(usd: number): void {
    if (Number.isFinite(usd)) this.totalUsd += usd;
  }

  statusLine(): string {
    return `$${this.totalUsd.toFixed(4)} session · ${this.inputTokens} in / ${this.outputTokens} out · ${this.cacheReadTokens} cached`;
  }
}

// Shared across the process so ingestion and the conversational loop share a total.
export const costMeter = new CostMeter();
