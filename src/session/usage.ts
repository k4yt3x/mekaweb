import type { Schema } from '../api/client';

export function contextMetrics(context: Schema['ContextResponse']) {
  const totals = context.totals;
  // Meka normalizes provider usage into three disjoint input tiers, including OpenAI cache hits.
  const totalInputTokens =
    totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
  const known = context.used != null && context.window != null && context.window > 0;
  return {
    totalInputTokens,
    cacheHitPercent:
      totalInputTokens > 0 ? (totals.cache_read_input_tokens / totalInputTokens) * 100 : null,
    // Rounded down, as meka reported it before leaving the division to clients.
    usedPercent: known ? Math.floor((context.used! * 100) / context.window!) : null,
    remainingTokens: known ? Math.max(0, context.window! - context.used!) : null,
  };
}
