import {
  useEffect,
  useState,
  isValidElement,
  memo,
  type ComponentProps,
  type ReactElement,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CircleAlert, Info, Lightbulb, OctagonAlert } from 'lucide-react';
import type { ThemedToken } from 'shiki';
import { CopyButton } from './common';
import { Diagram } from './diagram';
import { MarkdownTable } from './markdown-table';
import { Checkbox } from './ui/checkbox';
import { scrollRegion } from './scrolling';
import {
  normalizeMathDelimiters,
  remarkAdmonitions,
  remarkDisplayMath,
  rehypeTaskLabels,
  rehypeMathAccessibility,
} from './markdown-plugins';
import 'katex/dist/katex.min.css';

export function MarkdownPreview({ text }: { text: string }) {
  // A collapsed row needs only a bounded opening excerpt, without links, images, or heavy renderers.
  const source = text.trim();
  const preview = source.slice(0, 1024).replace(/\s+/g, ' ');
  return (
    <ReactMarkdown
      remarkPlugins={[remarkCjkFriendly]}
      allowedElements={['strong', 'em', 'del', 'code']}
      unwrapDisallowed
      skipHtml
    >
      {preview + (source.length > 1024 ? '…' : '')}
    </ReactMarkdown>
  );
}

function CodeBlock({ text, language }: { text: string; language: string | undefined }) {
  const [highlighted, setHighlighted] = useState<{
    source: string;
    language: string;
    tokens: ThemedToken[][] | undefined;
  }>();
  const tokens =
    highlighted?.source === text && highlighted.language === language
      ? highlighted.tokens
      : undefined;
  useEffect(() => {
    let active = true;
    if (language)
      void import('./highlighter')
        .then(async (module) => {
          const tokens = await module.highlight(text, language);
          if (active) setHighlighted({ source: text, language, tokens });
        })
        .catch(() => {
          /* Unknown grammars stay plain and copyable. */
        });
    return () => {
      active = false;
    };
  }, [language, text]);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language ?? 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code
          tabIndex={0}
          role="group"
          aria-label={language ? `${language} code` : 'Code'}
          onKeyDown={scrollRegion}
        >
          {tokens
            ? tokens.map((line, index) => (
                <span className="code-line" key={index}>
                  {line.map((token, i) => (
                    <span key={i} style={token.htmlStyle}>
                      {token.content}
                    </span>
                  ))}
                  {index < tokens.length - 1 ? '\n' : ''}
                </span>
              ))
            : text}
        </code>
      </pre>
    </div>
  );
}
function FencedBlock({ children }: ComponentProps<'pre'>) {
  if (!isValidElement(children)) return <pre>{children}</pre>;
  const code = children as ReactElement<ComponentProps<'code'>>;
  const text = String(code.props.children ?? '').replace(/\n$/, '');
  const language = /language-([^\s]+)/.exec(code.props.className ?? '')?.[1];
  return language?.toLowerCase() === 'mermaid' ? (
    <Diagram source={text} />
  ) : (
    <CodeBlock text={text} language={language} />
  );
}
const alertTitles: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.classList.contains('katex-display'))
          scrollRegion(event, event.target);
      }}
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkCjkFriendly,
          remarkMath,
          remarkDisplayMath,
          remarkAdmonitions,
        ]}
        rehypePlugins={[
          rehypeTaskLabels,
          [
            rehypeKatex,
            {
              trust: false,
              strict: 'ignore',
              maxExpand: 1000,
              maxSize: 20,
              errorColor: 'var(--danger)',
            },
          ],
          rehypeMathAccessibility,
        ]}
        skipHtml
        components={{
          pre: FencedBlock,
          table: MarkdownTable,
          input: ({ type, checked, 'aria-label': label }) =>
            type === 'checkbox' ? (
              <Checkbox checked={Boolean(checked)} disabled aria-label={label} />
            ) : null,
          blockquote: ({ children, node }) => {
            const kind = String(node?.properties['data-alert'] ?? node?.properties.dataAlert ?? '');
            if (!Object.hasOwn(alertTitles, kind)) return <blockquote>{children}</blockquote>;
            const Icon =
              kind === 'tip'
                ? Lightbulb
                : kind === 'caution'
                  ? OctagonAlert
                  : kind === 'warning'
                    ? CircleAlert
                    : Info;
            return (
              <aside
                className={`markdown-alert markdown-alert-${kind}`}
                role="note"
                aria-label={alertTitles[kind]}
              >
                <div className="alert-heading">
                  <Icon size={16} />
                  {alertTitles[kind]}
                </div>
                {children}
              </aside>
            );
          },
          a: ({ children, href, title, id, node }) => {
            const fragment = href?.startsWith('#');
            return (
              <a
                href={href}
                title={title}
                id={id}
                target={fragment ? undefined : '_blank'}
                rel={fragment ? undefined : 'noreferrer noopener'}
                aria-label={node?.properties.dataFootnoteBackref ? 'Back to reference' : undefined}
                onClick={
                  fragment
                    ? (event) => {
                        event.preventDefault();
                        const target = event.currentTarget
                          .closest('.markdown')
                          ?.querySelector<HTMLElement>(
                            `[id="${CSS.escape(href?.slice(1) ?? '')}"]`,
                          );
                        target?.scrollIntoView({ block: 'nearest' });
                        target?.focus({ preventScroll: true });
                      }
                    : undefined
                }
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => (
            <a href={src} target="_blank" rel="noreferrer noopener">
              {alt || 'External image'} (open image)
            </a>
          ),
        }}
      >
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  );
});
