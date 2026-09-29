import { expect, it } from 'vitest';
import { load } from './highlighter';

it('loads a grammar once, then highlights synchronously so blocks colour as they render', async () => {
  const highlight = await load('Python');
  const tokens = highlight?.('def run():\n    return 1');
  expect(tokens).toHaveLength(2);
  expect(tokens?.[0]?.map((token) => token.content).join('')).toBe('def run():');
  expect(tokens?.[0]?.[0]?.htmlStyle).toHaveProperty('--shiki-dark');
  expect(highlight?.('x'.repeat(100001))).toBeUndefined();
  expect(await load('golang')).toBeTypeOf('function');
  expect(await load('not-a-language')).toBeUndefined();
});
