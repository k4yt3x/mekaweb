import type { RefObject } from 'react';
import { Activity, CalendarClock, FolderOpen, Gauge, SquareTerminal } from 'lucide-react';
import { Button } from '../components/ui/button';
import { shortcutAttribute, shortcutHint, type Shortcut } from '../components/shortcut-keys';
import type { Panel } from '../connections/storage';
import { PANEL_TITLES } from './workspace-layout';

const PANEL_ITEMS: Record<Panel, { Icon: typeof FolderOpen; shortcut: Shortcut }> = {
  files: { Icon: FolderOpen, shortcut: 'toggleFiles' },
  context: { Icon: Gauge, shortcut: 'toggleContext' },
  tasks: { Icon: Activity, shortcut: 'toggleTasks' },
  schedules: { Icon: CalendarClock, shortcut: 'toggleSchedules' },
};

/**
 * The column of buttons at the right of a session on a wide screen: one for each side panel there
 * is, which shows one at a time, and below them the terminal's, which shows a terminal's tab in the
 * editor. Tasks counts the ones running, and the terminal is marked while a shell runs out of sight.
 */
export function SessionRail({
  panels,
  shown,
  onPanel,
  terminal,
  running,
  buttons,
}: {
  panels: readonly Panel[];
  shown: Panel | undefined;
  onPanel: (panel: Panel) => void;
  terminal: { shown: boolean; running: boolean; onToggle: () => void } | undefined;
  /** How many background tasks are running. */
  running: number;
  /** Each panel's button, to give the keyboard back to when the panel closes. */
  buttons: RefObject<Map<Panel, HTMLButtonElement>>;
}) {
  return (
    <aside className="session-rail" aria-label="Panels">
      {panels.map((panel) => {
        const { Icon, shortcut } = PANEL_ITEMS[panel];
        const title = PANEL_TITLES[panel];
        const count = panel === 'tasks' && running > 0 ? running : 0;
        return (
          <Button
            key={panel}
            ref={(element) => {
              if (element) buttons.current.set(panel, element);
              else buttons.current.delete(panel);
            }}
            variant="ghost"
            size="icon"
            aria-label={count ? `${title}, ${count.toLocaleString()} running` : title}
            title={`${title} (${shortcutHint(shortcut)})`}
            aria-keyshortcuts={shortcutAttribute(shortcut)}
            aria-pressed={shown === panel}
            aria-controls="session-panel"
            onClick={() => onPanel(panel)}
          >
            <Icon size={18} aria-hidden="true" />
            {count > 0 && (
              <span className="session-rail-count" aria-hidden="true">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </Button>
        );
      })}
      {terminal && (
        <>
          {panels.length > 0 && <span className="session-rail-divider" aria-hidden="true" />}
          <Button
            variant="ghost"
            size="icon"
            aria-label={terminal.running && !terminal.shown ? 'Terminal, running' : 'Terminal'}
            title={`Terminal (${shortcutHint('toggleTerminal')})`}
            aria-keyshortcuts={shortcutAttribute('toggleTerminal')}
            aria-pressed={terminal.shown}
            onClick={terminal.onToggle}
          >
            <SquareTerminal size={18} aria-hidden="true" />
            {terminal.running && !terminal.shown && (
              <span className="session-rail-dot" aria-hidden="true" />
            )}
          </Button>
        </>
      )}
    </aside>
  );
}
