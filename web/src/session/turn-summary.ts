import type { Schema } from '../api/client';

type TurnRecord = Schema['TurnRecord'];

/** How a turn ended, in the word meka's terminal starts its closing row with. */
const ENDINGS: Record<string, string> = {
  succeeded: 'Finished',
  failed: 'Failed',
  canceled: 'Interrupted',
};

/** Who opened a turn, when not the person at a client. */
const SOURCES: Record<string, string> = {
  inbox: 'Inbox message',
  schedule: 'Schedule',
  background: 'Background work',
  parent: 'Parent session',
  compaction: 'Compaction',
};

/** Why a turn that succeeded stopped, when not at the end of its reply. */
const STOPS: Record<string, string> = {
  max_tokens: 'Output limit reached',
  refusal: 'The model refused',
};

/**
 * A duration as meka's terminal states it: seconds under a minute, minutes and seconds under an
 * hour, then hours and minutes, then days and hours.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
}

/** A token count as meka's terminal states it: `999`, `1.0k`, `2.3M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

function clock(date: Date, seconds = false) {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

function day(date: Date, now: Date) {
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** When `date` was, to the second, with its day unless it is today. */
function moment(date: Date, now: Date) {
  return sameDay(date, now) ? clock(date, true) : `${day(date, now)}, ${clock(date, true)}`;
}

/** How long the turn ran, if its times say. */
function elapsed(turn: TurnRecord) {
  if (!turn.ended_at) return;
  const ms = Date.parse(turn.ended_at) - Date.parse(turn.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * The row that closes an ended turn, as meka's terminal writes it: how it ended, when, and after how
 * long, such as `Finished at 10:36 after 9m 36s`. None for a turn that has not ended.
 */
export function turnSummary(turn: TurnRecord, now = new Date()): string | undefined {
  if (!turn.status || !turn.ended_at) return;
  const ended = new Date(turn.ended_at);
  if (Number.isNaN(ended.getTime())) return;
  const when = sameDay(ended, now)
    ? `at ${clock(ended)}`
    : `on ${day(ended, now)} at ${clock(ended)}`;
  const ran = elapsed(turn);
  return [
    ENDINGS[turn.status] ?? 'Ended',
    when,
    ran === undefined ? '' : `after ${formatElapsed(ran)}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** What an ended turn's summary tells on a closer look, as labelled values in order. */
export function turnDetails(turn: TurnRecord, now = new Date()) {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | undefined | null) => {
    if (value) rows.push({ label, value });
  };
  add('Started', moment(new Date(turn.started_at), now));
  if (turn.ended_at) add('Ended', moment(new Date(turn.ended_at), now));
  const ran = elapsed(turn);
  if (ran !== undefined) add('Duration', formatElapsed(ran));
  const usage = turn.usage;
  const input =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  if (input || usage.output_tokens) {
    add('Tokens in', formatTokens(input));
    add('Tokens out', formatTokens(usage.output_tokens));
    if (input)
      add(
        'Cached',
        `${Math.round((usage.cache_read_input_tokens / input) * 100)}% (${formatTokens(usage.cache_read_input_tokens)})`,
      );
    if (usage.cache_creation_input_tokens)
      add('Cache written', formatTokens(usage.cache_creation_input_tokens));
  }
  if (turn.source !== 'client') add('Started by', SOURCES[turn.source] ?? turn.source);
  if (turn.profile) add('Fallback profile', turn.profile);
  if (turn.stop_reason) add('Stopped', STOPS[turn.stop_reason]);
  if (turn.status === 'canceled') add('Reason', turn.reason);
  if (turn.status === 'failed') add('Error', turn.error?.detail);
  return rows;
}
