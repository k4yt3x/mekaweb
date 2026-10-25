import { expect, it } from 'vitest';
import { remarkAdmonitions } from './markdown-plugins';
import type { Root } from 'mdast';
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
