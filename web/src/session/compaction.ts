import type { Schema } from '../api/client';

// meka 0.84.0: src/conversation.rs::CompactionRecord::note, the line its screen shows.
const triggers: Readonly<Record<string, string>> = {
  reactive: 'Autocompacted the conversation after context usage crossed the ceiling.',
  proactive: 'Autocompacted the conversation ahead of a turn that would have crossed the ceiling.',
  manual: 'Compacted the conversation on user request.',
  requested: 'The agent compacted the conversation.',
  emergency: 'Compacted the conversation after the provider refused the request as too large.',
  retention: 'Autocompacted the conversation to summarize turns older than the retention window.',
};

/** A compaction in one line, as meka says it: what set it going, then what was not usual. */
export function compactionNote(compaction: Schema['CompactionView']): string {
  const parts = [triggers[compaction.trigger] ?? 'Compacted the conversation.'];
  if (!compaction.kept_recent) parts.push('No recent turns were kept.');
  if (compaction.source === 'summarizer') parts.push('Written by the standalone summarizer.');
  const written = compaction.memories_written;
  if (written.length)
    parts.push(
      `Wrote ${written.length} ${written.length === 1 ? 'memory' : 'memories'}: ${written.join(', ')}.`,
    );
  return parts.join(' ');
}
