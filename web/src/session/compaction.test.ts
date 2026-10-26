import { expect, it } from 'vitest';
import { compactionNote } from './compaction';

const usual = {
  trigger: 'reactive',
  source: 'checkpoint',
  memories_written: [],
  kept_recent: true,
  replaced_count: 12,
  generation: 1,
};

it('says what set a compaction going, as meka’s screen does', () => {
  expect(compactionNote(usual)).toBe(
    'Autocompacted the conversation after context usage crossed the ceiling.',
  );
  expect(compactionNote({ ...usual, trigger: 'manual' })).toBe(
    'Compacted the conversation on user request.',
  );
  expect(compactionNote({ ...usual, trigger: 'later' })).toBe('Compacted the conversation.');
});

it('adds what was not usual about it', () => {
  expect(
    compactionNote({
      ...usual,
      trigger: 'requested',
      source: 'summarizer',
      kept_recent: false,
      memories_written: ['notes', 'plan'],
    }),
  ).toBe(
    'The agent compacted the conversation. No recent turns were kept. Written by the standalone ' +
      'summarizer. Wrote 2 memories: notes, plan.',
  );
  expect(compactionNote({ ...usual, memories_written: ['notes'] })).toMatch(
    /ceiling\. Wrote 1 memory: notes\.$/,
  );
});
