import type { Schema } from '../api/client';

export function contextMetrics(context: Schema['ContextResponse']) {
  const totals = context.totals;
  // Meka normalizes provider usage into three disjoint input tiers, including OpenAI cache hits.
  const totalInputTokens =
    totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
  return {
    totalInputTokens,
    cacheHitPercent:
      totalInputTokens > 0 ? (totals.cache_read_input_tokens / totalInputTokens) * 100 : null,
    remainingTokens:
      context.used != null && context.window != null && context.window > 0
        ? Math.max(0, context.window - context.used)
        : null,
  };
}
