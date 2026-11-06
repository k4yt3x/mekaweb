import type { Schema } from '../api/client';

export function contextMetrics(context: Schema['ContextResponse']) {
  const known = context.used != null && context.window != null && context.window > 0;
  return {
    // Rounded down, as meka reported it before leaving the division to clients.
    usedPercent: known ? Math.floor((context.used! * 100) / context.window!) : null,
    remainingTokens: known ? Math.max(0, context.window! - context.used!) : null,
  };
}

/** What a session spent across its turns, as its record says. */
export function usageMetrics(usage: Schema['TurnUsage']) {
  // Meka normalizes provider usage into three disjoint input tiers, including OpenAI cache hits.
  const totalInputTokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  return {
    totalInputTokens,
    cacheHitPercent:
      totalInputTokens > 0 ? (usage.cache_read_input_tokens / totalInputTokens) * 100 : null,
  };
}

/**
 * Whether `used`, a share of the context window in percent, is near where meka compacts it, at
 * `compactAt` percent, or near full where it does not.
 */
export function contextNear(used: number, compactAt: number | null | undefined) {
  return used >= (compactAt ?? 90) - 10;
}
