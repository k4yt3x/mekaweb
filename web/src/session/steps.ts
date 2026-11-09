import { basename, language } from '../files/paths';

/**
 * The steps of an agent's turn: what it thinks and the tool calls it works through, between what
 * it says. Once it says something after them, or its turn ends, a run of them folds into one line
 * that tells what they did, as the words carry the turn and the steps are mostly read when
 * something went wrong. What it changes shows on its own, never folded: files, memories, skills.
 */

/** What an item of a turn is to folding: a step, an edit, words, or something else shown. */
export type Part = 'step' | 'edit' | 'words' | 'other';

/** A run of steps, `from` to `to` inclusive, and whether it is done; or an item on its own. */
export type Segment =
  { kind: 'run'; from: number; to: number; finished: boolean } | { kind: 'item'; at: number };

/** The tools whose calls change something the person keeps, which show what they change. */
const EDITS = new Set([
  'file_edit',
  'file_write',
  'memory_edit',
  'memory_write',
  'skill_edit',
  'skill_write',
]);

/** Calls that run a sub-agent, which show on their own, with what it does. */
const AGENTS = new Set(['agent_spawn', 'agent_followup']);

/** Whether the tool `name` changes a file, a memory or a skill. */
export function isEdit(name: string) {
  return EDITS.has(name);
}

/**
 * What an edit or a write changes, from its call alone, as Meka's own screen draws it: the text an
 * edit swaps for another, or the text a write puts in, whose old text the call does not hold. A
 * memory or a skill is Markdown.
 */
export function editChange(name: string, input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const text = (key: string) => {
    const field = value[key];
    return typeof field === 'string' ? field.replaceAll('\r\n', '\n') : undefined;
  };
  const path = text('path');
  const highlight = name.startsWith('file_') ? path && language(basename(path)) : 'markdown';
  if (name.endsWith('_edit')) {
    const before = text('old_string');
    const after = text('new_string');
    if (before === undefined || after === undefined) return undefined;
    return { before, after, language: highlight || undefined, every: value.replace_all === true };
  }
  const after = text(name === 'file_write' ? 'content' : 'body');
  if (after === undefined) return undefined;
  return { before: '', after, language: highlight || undefined, every: false };
}

/** What a call to the tool `name` is to folding. */
export function toolPart(name: string): Part {
  return EDITS.has(name) ? 'edit' : AGENTS.has(name) ? 'other' : 'step';
}

/**
 * `parts` as they show: each run of steps, one or more, and each item apart. Edits and other items
 * end a run, but only words, or the turn having `ended`, finish one. A run stays one as it grows,
 * so what it holds is not shown again. With `fold` off, every part is an item, as before.
 */
export function segments(parts: readonly Part[], ended: boolean, fold = true): Segment[] {
  if (!fold) return parts.map((_, at) => ({ kind: 'item', at }));
  const lastWords = parts.lastIndexOf('words');
  const shown: Segment[] = [];
  let from = -1;
  const close = (to: number) => {
    if (from < 0) return;
    shown.push({ kind: 'run', from, to, finished: ended || lastWords > to });
    from = -1;
  };
  parts.forEach((part, at) => {
    if (part === 'step') {
      if (from < 0) from = at;
      return;
    }
    close(at - 1);
    shown.push({ kind: 'item', at });
  });
  close(parts.length - 1);
  return shown;
}

/** A step, as a run's line counts it: thinking, a tool call, or a note Meka wrote into the turn. */
export type Step =
  { kind: 'thinking' } | { kind: 'note' } | { kind: 'tool'; name: string; failed: boolean };

type Family = 'thinking' | 'note' | 'command' | 'read' | 'search' | 'fetch' | 'other';

function family(step: Step): Family {
  if (step.kind !== 'tool') return step.kind;
  if (step.name === 'shell_execute') return 'command';
  if (step.name === 'file_read') return 'read';
  if (step.name === 'web_fetch') return 'fetch';
  if (step.name === 'file_find' || step.name.endsWith('_search')) return 'search';
  return 'other';
}

function times(count: number) {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${count.toLocaleString()} times`;
}

function counted(count: number, one: string, many: string) {
  return count === 1 ? one : `${count.toLocaleString()} ${many}`;
}

const PHRASES: Record<Family, (count: number) => string> = {
  thinking: (count) => `thought ${times(count)}`,
  note: (count) => `got ${counted(count, 'a note', 'notes')} from Meka`,
  command: (count) => `ran ${counted(count, 'a command', 'commands')}`,
  read: (count) => `read ${counted(count, 'a file', 'files')}`,
  search: (count) => `searched ${times(count)}`,
  fetch: (count) => `fetched ${counted(count, 'a page', 'pages')}`,
  other: (count) => `used ${counted(count, 'a tool', 'tools')}`,
};

/**
 * What a run did, in the order it first did each: "Ran 5 commands, read 2 files, thought 3 times";
 * and how many of its calls failed.
 */
export function describeRun(steps: readonly Step[]) {
  const counts = new Map<Family, number>();
  for (const step of steps) counts.set(family(step), (counts.get(family(step)) ?? 0) + 1);
  const text = [...counts].map(([each, count]) => PHRASES[each](count)).join(', ');
  return {
    text: text && text[0]!.toUpperCase() + text.slice(1),
    failed: steps.filter((step) => step.kind === 'tool' && step.failed).length,
  };
}
