import type { Schema } from '../api/client';
import { useSessionContext } from '../session/hooks';
import { contextMetrics, contextNear, usageMetrics } from '../session/usage';
import { Button } from '../components/ui/button';
import { useWorkspace } from '../components/workspace';

/** How full the session's context is, in the message box; it opens the context's details. */
export function ContextMeter({ session }: { session: string }) {
  const workspace = useWorkspace();
  const context = useSessionContext(session, { follow: true });
  const used = context.data ? contextMetrics(context.data).usedPercent : null;
  if (!context.data || used == null) return null;
  const compactAt = context.data.compact_at_percent;
  const title = `${used}% of context used · ${compactAt != null ? `compacts at ${compactAt}%` : 'auto-compact off'}`;
  // The ring's length is its circumference, so a dash of `filled` out of it fills that share.
  const filled = (Math.min(100, Math.max(0, used)) / 100) * RING;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="context-meter"
      data-near={contextNear(used, compactAt) || undefined}
      aria-label={title}
      title={title}
      onClick={() => workspace?.showContext()}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle className="context-meter-track" cx="10" cy="10" r="8" />
        <circle
          className="context-meter-fill"
          cx="10"
          cy="10"
          r="8"
          strokeDasharray={`${filled} ${RING}`}
        />
      </svg>
      <span>{used}%</span>
    </Button>
  );
}

const RING = 2 * Math.PI * 8;

export function SessionContext({
  context,
  session,
}: {
  context: Schema['ContextResponse'];
  session: Schema['SessionResponse'];
}) {
  const metrics = contextMetrics(context);
  const spent = usageMetrics(session.usage);
  return (
    <div className="context-details stack">
      <section aria-label="Context window">
        <h3>Context window</h3>
        {metrics.usedPercent != null ? (
          <>
            <progress aria-label="Context window occupancy" max={100} value={metrics.usedPercent} />
            <p>
              {metrics.usedPercent}% · {context.used?.toLocaleString()} /{' '}
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
            {spent.cacheHitPercent != null
              ? `${spent.cacheHitPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
              : 'Not reported'}
          </dd>
          <dt>Input tokens</dt>
          <dd>{spent.totalInputTokens.toLocaleString()}</dd>
          <dt>Uncached input</dt>
          <dd>{session.usage.input_tokens.toLocaleString()}</dd>
          <dt>Cache reads</dt>
          <dd>{session.usage.cache_read_input_tokens.toLocaleString()}</dd>
          <dt>Cache writes</dt>
          <dd>{session.usage.cache_creation_input_tokens.toLocaleString()}</dd>
          <dt>Output tokens</dt>
          <dd>{session.usage.output_tokens.toLocaleString()}</dd>
          <dt>Turns</dt>
          <dd>{session.turn_count.toLocaleString()}</dd>
        </dl>
      </section>
    </div>
  );
}
