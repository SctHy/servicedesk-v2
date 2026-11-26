function counters() {
  return {
    runs_total: 0,
    runs_failed: 0,
    tool_attempts: 0,
    tool_failures: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    tokens_total: 0,
    jobs_succeeded: 0,
    jobs_revoked: 0,
    jobs_manual_review: 0,
  }
}

export class Metrics {
  private tenants = new Map<string, ReturnType<typeof counters>>()
  for(tenant: string) {
    let row = this.tenants.get(tenant)
    if (!row) {
      row = counters()
      this.tenants.set(tenant, row)
    }
    return row
  }
  usage(tenant: string, usage: { toolAttempts: number; toolFailures: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }) {
    const row = this.for(tenant)
    row.tool_attempts += usage.toolAttempts
    row.tool_failures += usage.toolFailures
    row.cache_read_tokens += usage.cacheReadTokens
    row.cache_write_tokens += usage.cacheWriteTokens
    row.cost_usd += usage.costUsd
    row.tokens_total += usage.totalTokens
  }
}
