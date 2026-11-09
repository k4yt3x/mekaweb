import { describe, expect, it } from 'vitest';
import { describeRun, segments, toolPart, type Part } from './steps';

describe('folding a turn', () => {
  it('folds runs of steps once words follow them, leaving edits and words apart', () => {
    const parts: Part[] = ['step', 'step', 'edit', 'step', 'words', 'step', 'step'];
    expect(segments(parts, false)).toEqual([
      { kind: 'run', from: 0, to: 1, finished: true },
      { kind: 'item', at: 2 },
      { kind: 'run', from: 3, to: 3, finished: true },
      { kind: 'item', at: 4 },
      { kind: 'run', from: 5, to: 6, finished: false },
    ]);
  });

  it('finishes every run once the turn has ended', () => {
    expect(segments(['words', 'step', 'step'], true)).toEqual([
      { kind: 'item', at: 0 },
      { kind: 'run', from: 1, to: 2, finished: true },
    ]);
  });

  it('shows every part on its own with folding off', () => {
    expect(segments(['step', 'step', 'words'], true, false)).toEqual([
      { kind: 'item', at: 0 },
      { kind: 'item', at: 1 },
      { kind: 'item', at: 2 },
    ]);
  });

  it('tells edits and sub-agents from steps', () => {
    expect(['file_edit', 'skill_write', 'agent_spawn', 'shell_execute'].map(toolPart)).toEqual([
      'edit',
      'edit',
      'other',
      'step',
    ]);
  });
});

describe('a run’s line', () => {
  it('counts what it did, in the order it first did each', () => {
    const tool = (name: string, failed = false) => ({ kind: 'tool' as const, name, failed });
    expect(
      describeRun([
        tool('shell_execute'),
        { kind: 'thinking' },
        tool('shell_execute', true),
        tool('file_read'),
        tool('file_search'),
        tool('file_find'),
        { kind: 'thinking' },
        { kind: 'note' },
        tool('checklist_update'),
      ]),
    ).toEqual({
      text: 'Ran 2 commands, thought twice, read a file, searched twice, got a note from Meka, used a tool',
      failed: 1,
    });
  });
});
