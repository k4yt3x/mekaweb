import type { Schema } from '../api/client';
import { contextMetrics } from '../session/usage';

export function SessionContext({ context }: { context: Schema['ContextResponse'] }) {
  const metrics = contextMetrics(context);
  return (
    <div className="context-details stack">
      <section aria-label="Context window">
        <h3>Context window</h3>
        {context.used_percent != null ? (
          <>
            <progress
              aria-label="Context window occupancy"
              max={100}
              value={context.used_percent}
            />
            <p>
              {context.used_percent}% · {context.used?.toLocaleString()} /{' '}
              {context.window?.toLocaleString()} tokens
            </p>
          </>
        ) : (
          <p className="muted">Usage not reported yet.</p>
        )}
        <dl className="facts">
          {metrics.remainingTokens != null && (
            <>
              <dt>Tokens remaining</dt>
              <dd>{metrics.remainingTokens.toLocaleString()}</dd>
            </>
          )}
          <dt>Auto-compact</dt>
          <dd>{context.compact_at_percent != null ? `${context.compact_at_percent}%` : 'Off'}</dd>
          {context.message_count != null && (
            <>
              <dt>Context messages</dt>
              <dd>{context.message_count.toLocaleString()}</dd>
            </>
          )}
          <dt>Compactions</dt>
          <dd>{context.generation.toLocaleString()}</dd>
        </dl>
      </section>
      <section aria-label="Session usage">
        <h3>Session usage</h3>
        <dl className="facts">
          <dt title="Cache reads divided by all input tokens, across the session">
            Cache hit rate
          </dt>
          <dd className="cache-hit-rate">
            {metrics.cacheHitPercent != null
              ? `${metrics.cacheHitPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
              : 'Not reported'}
          </dd>
          <dt>Input tokens</dt>
          <dd>{metrics.totalInputTokens.toLocaleString()}</dd>
          <dt>Uncached input</dt>
          <dd>{context.totals.input_tokens.toLocaleString()}</dd>
          <dt>Cache reads</dt>
          <dd>{context.totals.cache_read_input_tokens.toLocaleString()}</dd>
          <dt>Cache writes</dt>
          <dd>{context.totals.cache_creation_input_tokens.toLocaleString()}</dd>
          <dt>Output tokens</dt>
          <dd>{context.totals.output_tokens.toLocaleString()}</dd>
          <dt>Turns completed</dt>
          <dd>{context.totals.turns.toLocaleString()}</dd>
        </dl>
      </section>
    </div>
  );
}
