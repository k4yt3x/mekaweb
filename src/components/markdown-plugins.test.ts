import { expect, it } from 'vitest';
import { normalizeMathDelimiters, remarkAdmonitions } from './markdown-plugins';
import type { Root } from 'mdast';
it('normalizes TeX prose without changing fenced, indented, or inline source code', () => {
  const code = '```typescript\nconst x = "\\(literal\\)";\n```';
  const inline = '`\\(literal\\)`';
  const indented = '    \\(indented\\)';
  const source = [
    'Inline \\(a+b\\).',
    '',
    '\\[',
    'x^2',
    '\\]',
    '',
    code,
    '',
    inline,
    '',
    indented,
  ].join('\n');
  const normalized = normalizeMathDelimiters(source);
  expect(normalized).toContain('Inline $a+b$.');
  expect(normalized).toContain('$$\n\nx^2\n\n$$');
  expect(normalized).toContain(code);
  expect(normalized).toContain(inline);
  expect(normalized).toContain(indented);
});
it('keeps an unfinished streamed code fence literal', () => {
  const source = '```text\n\\(not a formula\\)';
  expect(normalizeMathDelimiters(source)).toBe(source);
});
it('recognizes only the supported admonition markers without dropping their body', () => {
  const tree: Root = {
    type: 'root',
    children: [
      {
        type: 'blockquote',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: '[!NOTE]\nKeep this text.' }] },
        ],
      },
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Ordinary quote.' }] }],
      },
    ],
  };
  remarkAdmonitions()(tree);
  expect(tree.children[0]?.data?.hProperties?.['data-alert']).toBe('note');
  expect(JSON.stringify(tree)).toContain('Keep this text.');
  expect(tree.children[1]?.data).toBeUndefined();
});
