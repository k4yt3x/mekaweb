import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChecklistStrip } from './checklist-strip';

it('shows nothing once the checklist is empty', () => {
  expect(renderToStaticMarkup(<ChecklistStrip items={[]} />)).toBe('');
});

it('names how many items are open and the one in progress', () => {
  const markup = renderToStaticMarkup(
    <ChecklistStrip
      items={[
        { id: 1, text: 'update the docs', status: 'pending' },
        { id: 2, text: 'write the tests', status: 'in_progress' },
        { id: 3, text: 'book the venue', status: 'deferred', reason: 'waiting on Sam' },
      ]}
    />,
  );
  expect(markup).toContain('3 open');
  expect(markup).toContain('write the tests');
  expect(markup).not.toContain('update the docs');
});
