import {
  useEffect,
  useState,
  isValidElement,
  memo,
  type ComponentProps,
  type ReactElement,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CircleAlert, Info, Lightbulb, OctagonAlert } from 'lucide-react';
import type { ThemedToken } from 'shiki';
import { CopyButton, ErrorNotice } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Diagram } from './diagram';
import { scrollRegion } from './scrolling';
import {
  normalizeMathDelimiters,
  remarkAdmonitions,
  remarkDisplayMath,
  rehypeTaskLabels,
  rehypeMathAccessibility,
} from './markdown-plugins';
import { ApiClient, sessionPath, segment } from '../api/client';
import { useConnection } from '../connections/context';
import 'katex/dist/katex.min.css';

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
        remarkPlugins={[remarkGfm, remarkMath, remarkDisplayMath, remarkAdmonitions]}
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
          table: ({ children }) => (
            <div
              className="table-scroll"
              role="group"
              aria-label="Table"
              tabIndex={0}
              onKeyDown={scrollRegion}
            >
              <table>{children}</table>
            </div>
          ),
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
async function imageBlob(api: ApiClient, id: string, hash: string, signal: AbortSignal) {
  const blob = await api.blob(sessionPath(id) + '/blobs/' + segment(hash), undefined, signal);
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(blob.type))
    throw new Error('The server returned an unsupported image type.');
  return blob;
}
export function Attachment({
  sessionId,
  hash,
  mediaType,
}: {
  sessionId: string;
  hash?: string | null | undefined;
  mediaType: string;
}) {
  const { api } = useConnection();
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<{
    api: ApiClient;
    sessionId: string;
    hash: string;
    url?: string;
    error?: unknown;
  }>();
  const current =
    image && image.api === api && image.sessionId === sessionId && image.hash === hash
      ? image
      : undefined;
  useEffect(() => {
    if (!api || !hash) return;
    const abort = new AbortController();
    let url = '';
    void imageBlob(api, sessionId, hash, abort.signal)
      .then((blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage({ api, sessionId, hash, url });
      })
      .catch((error) => {
        if (!abort.signal.aborted) setImage({ api, sessionId, hash, error });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, sessionId, hash]);
  if (current?.error) return <ErrorNotice error={current.error} />;
  if (!current?.url)
    return (
      <p className="muted small">{hash ? 'Loading image…' : 'Image bytes are unavailable.'}</p>
    );
  return (
    <>
      <button
        type="button"
        className="attachment"
        aria-label="View image"
        onClick={() => setOpen(true)}
      >
        <img src={current.url} alt="Conversation attachment" loading="lazy" />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Image" wide>
        <img className="image-preview" src={current.url} alt="Full-size conversation attachment" />
        <div className="actions">
          <Button asChild variant="secondary">
            <a href={current.url} download={`attachment.${mediaType.split('/')[1] ?? 'bin'}`}>
              Download image
            </a>
          </Button>
        </div>
      </Dialog>
    </>
  );
}
