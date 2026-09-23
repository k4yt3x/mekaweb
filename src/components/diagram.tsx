import { useEffect, useState, useSyncExternalStore } from 'react';
import { CopyButton } from './common';
import { Dialog } from './ui/dialog';
import { Maximize2 } from 'lucide-react';
import { scrollRegion } from './scrolling';

function subscribeTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
export function Diagram({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const dark = useSyncExternalStore(subscribeTheme, () =>
    document.documentElement.classList.contains('dark'),
  );
  const [result, setResult] = useState<{
    source: string;
    dark: boolean;
    url?: string;
    title?: string;
    error?: string;
  }>();
  const current = result?.source === source && result.dark === dark ? result : undefined;
  useEffect(() => {
    const abort = new AbortController();
    let url = '';
    const timer = setTimeout(() => {
      void import('./mermaid-renderer')
        .then((module) => module.renderDiagram(source, dark, abort.signal))
        .then((image) => {
          if (abort.signal.aborted) return;
          url = URL.createObjectURL(image.blob);
          setResult({ source, dark, url, title: image.title });
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setResult({
              source,
              dark,
              error: error instanceof Error ? error.message : 'The diagram could not be rendered.',
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, dark]);
  return (
    <figure className="diagram">
      {current?.url ? (
        <div className="diagram-scroll">
          <button
            className="diagram-preview"
            aria-label="Expand diagram"
            title="Expand diagram"
            onClick={() => setExpanded(true)}
          >
            <img src={current.url} alt={current.title ?? 'Mermaid diagram'} />
            <Maximize2 className="diagram-expand" size={26} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <p className="muted small diagram-status">
          {current?.error
            ? 'Diagram preview unavailable. The source is below.'
            : 'Rendering diagram…'}
        </p>
      )}
      <details className="diagram-source">
        <summary>Diagram source</summary>
        <div className="code-block">
          <div className="code-toolbar">
            <span>mermaid</span>
            <CopyButton text={source} label="Copy diagram source" />
          </div>
          <pre>
            <code
              tabIndex={0}
              role="group"
              aria-label="Diagram source code"
              onKeyDown={scrollRegion}
            >
              {source}
            </code>
          </pre>
        </div>
        {current?.error && <p className="muted small">{current.error}</p>}
      </details>
      <Dialog open={expanded} onOpenChange={setExpanded} title="Diagram" wide>
        {current?.url && (
          <div
            className="diagram-expanded"
            role="group"
            aria-label="Expanded diagram"
            tabIndex={0}
            onKeyDown={scrollRegion}
          >
            <img src={current.url} alt={current.title ?? 'Mermaid diagram'} />
          </div>
        )}
      </Dialog>
    </figure>
  );
}
