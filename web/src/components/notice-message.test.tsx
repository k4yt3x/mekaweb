import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NoticeMessage } from './notice-message';

it('renders server text literally, with no executable HTML or hidden disclosure', () => {
  const html = renderToStaticMarkup(
    <NoticeMessage
      notice={{ level: 'warning', text: '<img src="x" onerror="alert(1)">\n**Untrusted**' }}
    />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('<strong>Warning</strong>');
  expect(html).toContain('&lt;img');
  expect(html).toContain('**Untrusted**');
  expect(html).not.toMatch(/<(?:img|details|script)\b/);
});

it('announces a turn failure as an error message', () => {
  const html = renderToStaticMarkup(
    <NoticeMessage notice={{ level: 'error', text: 'Provider failed' }} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('<strong>Error</strong>');
  expect(html).toContain('<p>Provider failed</p>');
});
