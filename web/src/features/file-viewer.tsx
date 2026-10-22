import { useState, type CSSProperties } from 'react';
import { AtSign, BookOpen, Code, Download, ExternalLink, FileQuestion } from 'lucide-react';
import { useGateway } from '../connections/context';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { CopyButton, ErrorNotice, Loading, Timestamp, WrapButton } from '../components/common';
import { Markdown } from '../components/markdown';
import { useHighlight } from '../components/use-highlight';
import { scrollRegion } from '../components/scrolling';
import { mentionPath, useWorkspace } from '../components/workspace';
import type { Gateway } from '../api/gateway';
import { basename, formatSize, language, previewKind, rawUrl } from '../files/paths';

type Entry = Gateway['Entry'];

/** The longest text the viewer renders or highlights without being asked. */
const MAX_RICH_CHARS = 256 * 1024;

/**
 * A file, opened from Files: a fixed frame with its name, details and actions, and the file
 * filling the rest, scrolling within it. Text shows with line numbers, Markdown rendered or as
 * source, and pictures, sound and video in place.
 */
export function FileViewer({
  entry,
  path,
  canMention,
  onClose,
}: {
  entry: Entry | undefined;
  path: string;
  canMention: boolean;
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  const name = entry?.name ?? '';
  const kind = entry ? previewKind(name) : 'text';
  return (
    <Dialog
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={name}
      className="file-viewer"
      headerActions={
        entry && (
          <>
            {canMention && workspace && (
              <Button
                variant="ghost"
                size="sm"
                title="Mention in message"
                onClick={() => {
                  workspace.mention(mentionPath(path));
                  onClose();
                }}
              >
                <AtSign size={14} />
                <span className="file-viewer-label">Mention</span>
              </Button>
            )}
            <a
              className="button button-ghost button-small"
              href={rawUrl(path, true)}
              download
              title="Download"
            >
              <Download size={14} />
              <span className="file-viewer-label">Download</span>
            </a>
          </>
        )
      }
    >
      {entry && (
        <>
          <p className="file-viewer-meta">
            <span className="file-viewer-path" title={path}>
              {path}
            </span>
            <span className="file-viewer-facts">
              {formatSize(entry.size)}
              {entry.modified && (
                <>
                  {' · '}
                  <Timestamp value={entry.modified} />
                </>
              )}
              {' · '}
              {entry.permissions}
            </span>
          </p>
          {kind === 'text' ? (
            <TextFile path={path} name={name} />
          ) : kind === 'pdf' ? (
            <div className="file-viewer-body file-viewer-empty">
              <FileQuestion size={28} aria-hidden="true" />
              <p>PDFs open in a tab of their own.</p>
              <a
                className="button button-secondary button-small"
                href={rawUrl(path)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink size={14} />
                Open the PDF
              </a>
            </div>
          ) : (
            <div className="file-viewer-body file-viewer-media">
              {kind === 'image' && <img src={rawUrl(path)} alt={basename(path)} />}
              {kind === 'video' && <video src={rawUrl(path)} controls playsInline />}
              {kind === 'audio' && <audio src={rawUrl(path)} controls />}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/** A text file: its lines, or for Markdown, the document they make. */
function TextFile({ path, name }: { path: string; name: string }) {
  const text = useGateway<Gateway['Text']>('/api/files/text', { path });
  const [wrap, setWrap] = useState(false);
  const [choice, setRendered] = useState<boolean>();
  const markdown = /\.(md|markdown)$/i.test(name);
  // Rendering or highlighting a long file would hold the page up; it shows plain unless asked.
  const large = (text.data?.text.length ?? 0) > MAX_RICH_CHARS;
  const rendered = markdown && (choice ?? !large);
  if (text.error || text.isPending)
    return (
      <div className="file-viewer-body file-viewer-empty">
        <ErrorNotice error={text.error} />
        {text.isPending && <Loading />}
      </div>
    );
  if (text.data.binary)
    return (
      <div className="file-viewer-body file-viewer-empty">
        <FileQuestion size={28} aria-hidden="true" />
        <p>This file is not text. Download it to open it.</p>
      </div>
    );
  const source = text.data.text.endsWith('\n') ? text.data.text.slice(0, -1) : text.data.text;
  const lines = source.split('\n').length;
  return (
    <>
      <div className="file-viewer-bar">
        <span className="file-viewer-note">
          {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}
          {text.data.truncated &&
            ` · the first ${formatSize(new TextEncoder().encode(text.data.text).length)}; download it for the rest`}
          {large && !rendered && ' · too long to highlight'}
        </span>
        {markdown && (
          <Button size="sm" variant="ghost" onClick={() => setRendered(!rendered)}>
            {rendered ? <Code size={14} /> : <BookOpen size={14} />}
            {rendered ? 'Show source' : 'Show rendered'}
          </Button>
        )}
        {!rendered && <WrapButton wrap={wrap} onWrapChange={setWrap} />}
        <CopyButton text={text.data.text} label="Copy the file's text" />
      </div>
      {rendered ? (
        <div className="file-viewer-body">
          <div className="file-viewer-document">
            <Markdown text={text.data.text} />
          </div>
        </div>
      ) : (
        <div className="file-viewer-body">
          <FileCode text={source} language={large ? undefined : language(name)} wrap={wrap} />
        </div>
      )}
    </>
  );
}

/** Lines of a file, numbered, highlighted once their grammar loads. */
function FileCode({
  text,
  language,
  wrap,
}: {
  text: string;
  language: string | undefined;
  wrap: boolean;
}) {
  const tokens = useHighlight(text, language);
  const lines = tokens ?? text.split('\n');
  return (
    <pre
      className="file-code"
      data-wrap={wrap || undefined}
      style={{ '--line-digits': String(lines.length).length } as CSSProperties}
      tabIndex={0}
      role="group"
      aria-label={language ? `${language} code` : 'Text'}
      onKeyDown={scrollRegion}
    >
      <code>
        {lines.map((line, index) => (
          <span className="file-line" key={index}>
            <span className="line-text">
              {typeof line === 'string'
                ? line
                : line.map((token, i) => (
                    <span key={i} style={token.htmlStyle}>
                      {token.content}
                    </span>
                  ))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
