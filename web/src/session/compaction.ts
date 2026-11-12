import type { Schema } from '../api/client';

// Meka 0.94.0: src/conversation.rs::CompactionRecord::note, the line its screen shows.
const triggers: Readonly<Record<string, string>> = {
  reactive: 'Autocompacted the conversation after context usage crossed the ceiling.',
  proactive: 'Autocompacted the conversation ahead of a turn that would have crossed the ceiling.',
  manual: 'Compacted the conversation on user request.',
  requested: 'The agent compacted the conversation.',
  emergency: 'Compacted the conversation after the provider rejected the request as too large.',
  retention: 'Autocompacted the conversation to summarize turns older than the retention window.',
};

/** The memories a compaction's checkpoint wrote, which stay written whatever became of it. */
function wrote(written: readonly string[]) {
  return written.length
    ? [
        `Wrote ${written.length} ${written.length === 1 ? 'memory' : 'memories'}: ${written.join(', ')}.`,
      ]
    : [];
}

/** A compaction in one line, as Meka says it: what set it going, then what was not usual. */
export function compactionNote(compaction: Schema['CompactionView']): string {
  const parts = [triggers[compaction.trigger] ?? 'Compacted the conversation.'];
  // A person who asked for no recent turns got what they asked for, which is nothing unusual.
  if (!compaction.kept_recent && compaction.person_keeps_recent !== false)
    parts.push('No recent turns were kept.');
  if (compaction.source === 'summarizer') parts.push('Written by the standalone summarizer.');
  return [...parts, ...wrote(compaction.memories_written)].join(' ');
}

/**
 * A compaction that ended without replacing the context: why it failed, when it did rather than
 * being stopped, and the memories its checkpoint wrote.
 */
export function compactionFailedNote(failed: Schema['CompactionFailedItem']): string {
  const error = failed.error?.trim();
  return [
    ...(error ? [`Error: ${error}${/[.!?]$/.test(error) ? '' : '.'}`] : []),
    'The context is unchanged.',
    ...wrote(failed.memories_written),
  ].join(' ');
}
