import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import {
  contextQuestion,
  extendHistory,
  prependHistory,
  rewindableTurns,
  startHistory,
  type ConversationMessage,
} from './history';

const at = (position: number, role: string, turn: string, text = `${role} ${position}`) => ({
  type: 'message' as const,
  position,
  created_at: '2026-11-06T00:00:00Z',
  turn_id: turn,
  role,
  content: [{ type: 'text' as const, text }],
});
const compaction = (position: number, kept = false): Schema['HistoryItem'] => ({
  type: 'compaction',
  position,
  created_at: '2026-11-06T00:00:00Z',
  summary: 'Earlier work.',
  checkpoint: [],
  trigger: 'manual',
  source: 'checkpoint',
  memories_written: [],
  kept_recent: kept,
  generation: 1,
});
const positions = (messages: readonly ConversationMessage[]) =>
  messages.map((message) => message.position);

it('shows a compaction where it happened, as its summary, and an edit not at all', () => {
  const saved = startHistory(
    [
      at(1, 'user', 'a'),
      compaction(2),
      at(3, 'user', 'b'),
      { type: 'rewind', position: 5, created_at: '', ranges: [], turns: 0 },
    ],
    5,
    undefined,
  );
  expect(positions(saved.messages)).toEqual([1, 2, 3]);
  expect(saved.messages[1]).toMatchObject({ content: [{ type: 'text', text: 'Earlier work.' }] });
  expect(saved.messages[1]?.compaction).toMatchObject({ generation: 1 });
});

it('takes what an edit took back out, and does not take items it holds again', () => {
  let saved = startHistory([at(1, 'user', 'a'), at(2, 'assistant', 'a')], 2, undefined);
  saved = extendHistory(saved, [at(3, 'user', 'b'), at(4, 'assistant', 'b')], 4);
  // Read again from before what it holds: nothing is added twice.
  saved = extendHistory(saved, [at(4, 'assistant', 'b')], 4);
  expect(positions(saved.messages)).toEqual([1, 2, 3, 4]);
  const rewind: Schema['HistoryItem'] = {
    type: 'rewind',
    position: 6,
    created_at: '',
    ranges: [{ from: 3, through: 5 }],
    turns: 1,
  };
  saved = extendHistory(saved, [rewind], 6);
  expect(positions(saved.messages)).toEqual([1, 2]);
  expect(saved.position).toBe(6);
  // A page read before the rewind cannot bring back what it took.
  saved = prependHistory(
    { ...saved, messages: [], earlier: true, before: 7 },
    [at(1, 'user', 'a'), at(3, 'user', 'b')],
    undefined,
  );
  expect(positions(saved.messages)).toEqual([1]);
});

it('leaves a page’s leading results to the page before, which holds their calls', () => {
  const result: ConversationMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'c', is_error: false, content: [] }],
  };
  const items: Schema['HistoryItem'][] = [
    { type: 'message', position: 10, created_at: '', ...result },
    at(11, 'assistant', 't'),
  ];
  const opened = startHistory(items, 11, 10);
  expect(positions(opened.messages)).toEqual([11]);
  // The next page is read from past the results it left, to hold them with their calls.
  expect(opened.before).toBe(11);
  expect(positions(startHistory(items, 11, undefined).messages)).toEqual([10, 11]);
});

it('takes a row Meka wrote while the page was read once, past the position it reported', () => {
  // Meka reads the position ahead of the page, so the page can hold a row past it.
  let saved = startHistory([at(1, 'user', 'a'), at(2, 'assistant', 'a')], 1, undefined);
  expect(saved.position).toBe(2);
  saved = extendHistory(saved, [at(3, 'user', 'b')], 2);
  saved = extendHistory(saved, [at(3, 'user', 'b'), at(4, 'assistant', 'b')], 3);
  expect(positions(saved.messages)).toEqual([1, 2, 3, 4]);
  expect(saved.position).toBe(4);
});

it('names only turns the context holds: answered after the last compaction, or as it says', () => {
  const messages = startHistory(
    [
      at(1, 'user', 'old'),
      at(2, 'assistant', 'old'),
      compaction(3),
      at(4, 'user', 'one'),
      at(5, 'assistant', 'one'),
      // A prompt Meka may have taken back: nothing answered it.
      at(6, 'user', 'withdrawn'),
      at(7, 'user', 'two'),
      at(8, 'assistant', 'two'),
    ],
    8,
    undefined,
  ).messages;
  expect(contextQuestion(messages)).toBe('0:withdrawn');
  // Unasked, it is left out.
  expect([...rewindableTurns(messages)]).toEqual([
    ['two', { start: 6, turns: 1 }],
    ['one', { start: 3, turns: 2, next: 'two' }],
  ]);
  // The context holds it: a failed turn that kept its prompt.
  expect(rewindableTurns(messages, { context: new Set([6]) }).get('withdrawn')).toEqual({
    start: 5,
    turns: 2,
    next: 'two',
  });
  // It does not: Meka took it back.
  expect(rewindableTurns(messages, { context: new Set([4, 5, 7, 8]) }).has('withdrawn')).toBe(
    false,
  );
  expect(contextQuestion(messages.slice(0, 5))).toBeUndefined();
});

it('names the turns a compaction kept, from the part of them the context holds', () => {
  const messages = startHistory(
    [
      at(1, 'user', 'summarized'),
      at(2, 'assistant', 'summarized'),
      // Kept in part: its opening is in the summary, its later round is not.
      at(3, 'user', 'part'),
      at(4, 'assistant', 'part'),
      at(5, 'user', 'kept'),
      at(6, 'assistant', 'kept'),
      compaction(7, true),
      at(8, 'user', 'after'),
      at(9, 'assistant', 'after'),
    ],
    9,
    undefined,
  ).messages;
  expect(contextQuestion(messages)).toBe('7:');
  // Unasked, only the turn after the compaction.
  expect([...rewindableTurns(messages).keys()]).toEqual(['after']);
  const turns = rewindableTurns(messages, { context: new Set([4, 5, 6, 7, 8, 9]) });
  expect([...turns]).toEqual([
    ['after', { start: 7, turns: 1 }],
    ['kept', { start: 4, turns: 2, next: 'after' }],
    ['part', { start: 3, turns: 3, next: 'kept' }],
  ]);
});

it('leaves out the first turn held while earlier history may hold its opening', () => {
  const messages = startHistory(
    [at(10, 'assistant', 'cut'), at(11, 'user', 'whole'), at(12, 'assistant', 'whole')],
    12,
    10,
  ).messages;
  expect([...rewindableTurns(messages, { earlier: true }).keys()]).toEqual(['whole']);
  expect([...rewindableTurns(messages).keys()]).toEqual(['whole', 'cut']);
});

it('moves past a page of edits alone, which shows nothing', () => {
  const rewind = (position: number): Schema['HistoryItem'] => ({
    type: 'rewind',
    position,
    created_at: '',
    ranges: [],
    turns: 0,
  });
  let saved = startHistory([rewind(20), at(21, 'user', 'a')], 21, 20);
  expect(saved.before).toBe(20);
  saved = prependHistory(saved, [rewind(15), rewind(19)], 15);
  expect(positions(saved.messages)).toEqual([21]);
  expect(saved.before).toBe(15);
  expect(saved.earlier).toBe(true);
});

it('holds whole the part after a compaction of a turn whose page opens on it', () => {
  const messages = startHistory(
    [
      compaction(10),
      at(11, 'assistant', 'split'),
      at(12, 'user', 'next'),
      at(13, 'assistant', 'next'),
    ],
    13,
    10,
  ).messages.map((message, index) => (index === 0 ? { ...message, turn_id: 'split' } : message));
  expect([...rewindableTurns(messages, { earlier: true }).keys()]).toEqual(['next', 'split']);
});
