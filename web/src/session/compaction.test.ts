import { expect, it } from 'vitest';
import { compactionFailedNote, compactionNote } from './compaction';

const usual = {
  trigger: 'reactive',
  source: 'checkpoint',
  memories_written: [],
  kept_recent: true,
  generation: 1,
};

it('says what set a compaction going, as Meka’s screen does', () => {
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

it('does not call keeping no recent turns unusual when the person asked for none', () => {
  const manual = { ...usual, trigger: 'manual', kept_recent: false };
  expect(compactionNote({ ...manual, person_keeps_recent: false })).toBe(
    'Compacted the conversation on user request.',
  );
  for (const asked of [{ person_keeps_recent: true }, { person_keeps_recent: null }, {}])
    expect(compactionNote({ ...manual, ...asked })).toBe(
      'Compacted the conversation on user request. No recent turns were kept.',
    );
});

it('says why a compaction failed, or nothing when it was stopped, and what its checkpoint wrote', () => {
  const failed = { trigger: 'reactive', memories_written: [], checkpoint: [] };
  expect(compactionFailedNote({ ...failed, error: 'the provider refused' })).toBe(
    'Error: the provider refused. The context is unchanged.',
  );
  expect(compactionFailedNote({ ...failed, error: 'It timed out.' })).toBe(
    'Error: It timed out. The context is unchanged.',
  );
  expect(compactionFailedNote({ ...failed, memories_written: ['notes'] })).toBe(
    'The context is unchanged. Wrote 1 memory: notes.',
  );
});
