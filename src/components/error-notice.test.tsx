import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ApiError, ConnectionError, UncertainMutationError } from '../api/client';
import { ErrorNotice } from './common';

it('omits connection failures owned by the global banner but keeps setup errors local', () => {
  expect(renderToStaticMarkup(<ErrorNotice error={new ConnectionError(undefined, true)} />)).toBe(
    '',
  );
  expect(renderToStaticMarkup(<ErrorNotice error={new ConnectionError()} />)).toContain(
    'Cannot reach this endpoint',
  );
});

it('keeps uncertain mutations and resource-specific errors visible', () => {
  expect(
    renderToStaticMarkup(
      <ErrorNotice error={new UncertainMutationError(new ConnectionError(undefined, true))} />,
    ),
  ).toContain('outcome could not be confirmed');
  expect(
    renderToStaticMarkup(<ErrorNotice error={new ApiError(422, { detail: 'Invalid title' })} />),
  ).toContain('Invalid title');
  expect(
    renderToStaticMarkup(<ErrorNotice error={new Error(new ConnectionError().message)} />),
  ).toContain('Cannot reach this endpoint');
});
