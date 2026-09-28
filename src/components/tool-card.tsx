import { useMemo, type ReactNode } from 'react';
import { Command } from 'lucide-react';
import { toolSummary } from '../session/tool-summary';
import { Json } from './common';
import { toolIconKey, toolIcons } from './tool-icons';

export function ToolCard({
  name,
  input,
  displaySummary,
  status,
  isError,
  children,
}: {
  name: string;
  input: unknown;
  displaySummary?: string | undefined;
  status: string;
  isError: boolean;
  children: ReactNode;
}) {
  const summary = useMemo(
    () => toolSummary(name, input, displaySummary),
    [name, input, displaySummary],
  );
  const Icon = toolIcons[toolIconKey(name)] ?? Command;
  return (
    <details className={`tool-card ${isError ? 'tool-error' : ''}`}>
      <summary>
        <Icon className="tool-symbol" size={14} aria-hidden="true" />
        <span className="tool-call-label">
          <span className="tool-name" title={name}>
            {name}
          </span>
          {summary && (
            <span className="tool-argument" title={summary}>
              <code>{summary}</code>
            </span>
          )}
        </span>
        <span className="badge tool-state">{status}</span>
      </summary>
      <div className="tool-details">
        <div className="tool-section">
          <h4>Arguments</h4>
          <Json value={input} />
        </div>
        {children}
      </div>
    </details>
  );
}
