import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MarkdownPreview } from './markdown';

it('flattens thinking into inline text while retaining basic formatting', () => {
  const html = renderToStaticMarkup(
    <MarkdownPreview text={'# Plan\n\nRead **the files** and consider `options`.\nThen decide.'} />,
  );
  expect(html).toContain('Plan Read <strong>the files</strong>');
  expect(html).toContain('<code>options</code>. Then decide.');
  expect(html).not.toMatch(/<(?:p|h1|pre)\b/);
  expect(html).not.toContain('\n');
});

it('does not create interactive links, fetch images, or execute raw HTML in a disclosure', () => {
  const html = renderToStaticMarkup(
    <MarkdownPreview
      text={
        'Read [the docs](https://example.invalid). ![image](https://example.invalid/image.png) <img src="x" onerror="alert(1)">'
      }
    />,
  );
  expect(html).toContain('Read the docs.');
  expect(html).not.toMatch(/<(?:a|img|script)\b/);
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('https://');
});

it('bounds long previews and marks the truncation', () => {
  const html = renderToStaticMarkup(
    <MarkdownPreview text={'Consider the options. '.repeat(1000)} />,
  );
  expect(html.length).toBeLessThan(1100);
  expect(html.endsWith('…')).toBe(true);
  expect(renderToStaticMarkup(<MarkdownPreview text={' \n\t '} />)).toBe('');
});

it('uses the same CJK emphasis rules in collapsed thinking previews', () => {
  const html = renderToStaticMarkup(
    <MarkdownPreview text={'**注意：**检查*（边界）*之后继续。`**保持原样：**代码`'} />,
  );
  expect(html).toBe(
    '<strong>注意：</strong>检查<em>（边界）</em>之后继续。<code>**保持原样：**代码</code>',
  );
});
