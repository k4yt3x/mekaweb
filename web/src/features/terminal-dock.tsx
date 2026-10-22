import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, RotateCw, SquareTerminal, X } from 'lucide-react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useGateway, useRuntime, useSettings } from '../connections/context';
import { Button } from '../components/ui/button';
import { ConfirmButton, ErrorNotice, Loading } from '../components/common';
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from '../components/media-query';
import { TERMINAL_FONT, TERMINAL_HEIGHT } from '../connections/storage';
import { appleKeyboard, matchesShortcut } from '../components/shortcut-keys';
import { isProblem, type Gateway, type GatewayClient } from '../api/gateway';

/**
 * A session's terminal: docked under its conversation on a wide screen, and over the whole screen
 * on a narrow one. The shell belongs to the session. Opening the dock starts one if the session
 * has none; hiding it leaves a bar while the shell runs, still attached; the shell ending closes
 * the dock. It closes with the session.
 */
export function TerminalDock({
  session,
  cwd,
  open,
  onOpenChange,
}: {
  session: string;
  cwd: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const desktop = useMediaQuery(DESKTOP_LAYOUT_QUERY);
  const runtime = useRuntime();
  const queries = useQueryClient();
  const { layout, terminalFontSize } = useSettings();
  const [dragging, setDragging] = useState<number>();
  const height = dragging ?? layout.terminalHeight ?? TERMINAL_HEIGHT.default;
  // A size set with Ctrl and the wheel or keys lasts until the terminal is hidden, as the
  // conversation's reading options last until the page reloads; Settings keeps the size.
  const [zoom, setZoom] = useState<number>();
  if (!open && zoom !== undefined) setZoom(undefined);
  const fontSize = zoom ?? terminalFontSize;
  const terminals = useGateway<Gateway['TerminalView'][]>('/api/terminals', { session });
  // The shell this dock started, until the list has it; and shells that ended, not attached to
  // again.
  const [started, setStarted] = useState<Gateway['TerminalView']>();
  const [ended, setEnded] = useState<readonly string[]>([]);
  const terminal = [...(terminals.data ?? []), ...(started ? [started] : [])].find(
    (candidate) => !ended.includes(candidate.id),
  );
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const tried = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  const dock = useRef<HTMLElement>(null);
  // Hidden while in use, as by its shortcut, it hands the keyboard back to the message.
  useLayoutEffect(() => {
    if (!open) handBack(dock.current);
  }, [open]);
  // Opened with no shell running, the dock starts one, once each time it opens or is retried.
  useEffect(() => {
    if (!open) {
      tried.current = undefined;
      return;
    }
    // A start under way is not repeated, even by hiding and showing the dock meanwhile.
    if (inFlight.current || tried.current === attempt || terminal || !terminals.isSuccess) return;
    tried.current = attempt;
    inFlight.current = true;
    setStarting(true);
    setFailure(undefined);
    runtime.gateway
      .send<Gateway['TerminalView']>('POST', '/api/terminals', {
        session,
        ...(cwd ? { cwd } : {}),
        cols: 80,
        rows: 24,
      })
      .then((view) => {
        setStarted(view);
        void queries.invalidateQueries({ queryKey: ['gateway'] });
      })
      .catch(setFailure)
      .finally(() => {
        inFlight.current = false;
        setStarting(false);
      });
  }, [open, attempt, terminal, terminals.isSuccess, runtime, session, cwd, queries]);
  function finished(id: string) {
    handBack(dock.current);
    setEnded((value) => [...value, id]);
    onOpenChange(false);
    void queries.invalidateQueries({ queryKey: ['gateway'] });
  }
  if (!open && !terminal) return null;
  const save = (value: number) => {
    runtime.storage.layout({ terminalHeight: value });
    setDragging(undefined);
  };
  return (
    <section
      ref={dock}
      className="terminal-dock"
      data-state={open ? 'open' : 'minimized'}
      data-layout={desktop ? 'docked' : 'full'}
      style={open && desktop ? { height } : undefined}
      aria-label="Terminal"
    >
      {open && desktop && (
        <TerminalResizeHandle
          value={height}
          onResize={setDragging}
          onCommit={save}
          onCancel={() => setDragging(undefined)}
        />
      )}
      <header className="terminal-dock-bar">
        {open ? (
          <>
            <strong>Terminal</strong>
            <span className="muted small terminal-dock-cwd" title={terminal?.cwd ?? cwd ?? ''}>
              {terminal?.cwd ?? cwd}
            </span>
          </>
        ) : (
          <button
            type="button"
            className="terminal-dock-show"
            title="Show terminal"
            onClick={() => onOpenChange(true)}
          >
            <SquareTerminal size={14} aria-hidden="true" />
            <strong>Terminal</strong>
            <span className="muted small terminal-dock-cwd">{terminal?.cwd ?? cwd}</span>
          </button>
        )}
        <div className="actions">
          {terminal && (
            <ConfirmButton
              title="Close terminal"
              description="Close this terminal? Its shell and everything running in it stop."
              onConfirm={async () => {
                await closeTerminal(runtime.gateway, terminal.id);
                finished(terminal.id);
              }}
            >
              <X size={14} />
              Close
            </ConfirmButton>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={open ? 'Hide terminal' : 'Show terminal'}
            title={open ? 'Hide terminal; it keeps running' : 'Show terminal'}
            onClick={() => onOpenChange(!open)}
          >
            {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </Button>
        </div>
      </header>
      <div className="terminal-dock-body" hidden={!open}>
        <ErrorNotice error={terminals.error ?? failure} />
        {terminal ? (
          <TerminalView
            key={terminal.id}
            id={terminal.id}
            active={open}
            fontSize={fontSize}
            onZoom={setZoom}
            onEnded={() => finished(terminal.id)}
          />
        ) : terminals.isPending || starting ? (
          <Loading label="Starting a shell…" />
        ) : failure || terminals.error ? (
          <div className="terminal-start">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (terminals.error) void terminals.refetch();
                else setAttempt((value) => value + 1);
              }}
            >
              <RotateCw size={14} />
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Hands the keyboard back to the session's message, if it was in the terminal `dock`. */
function handBack(dock: HTMLElement | null) {
  if (!dock?.contains(document.activeElement)) return;
  dock
    .closest('.session-main')
    ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
    ?.focus();
}

/** The dock's top edge, dragged or moved with arrow keys to set its height. */
function TerminalResizeHandle({
  value,
  onResize,
  onCommit,
  onCancel,
}: {
  value: number;
  onResize: (height: number) => void;
  onCommit: (height: number) => void;
  onCancel: () => void;
}) {
  const drag = useRef<{ y: number; height: number; current: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  // The conversation keeps room for its newest lines and the composer.
  const max = Math.max(
    TERMINAL_HEIGHT.min,
    Math.min(TERMINAL_HEIGHT.max, window.innerHeight - 200),
  );
  const clamp = (height: number) =>
    Math.round(Math.min(max, Math.max(TERMINAL_HEIGHT.min, height)));
  return (
    <div
      className="terminal-dock-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize the terminal"
      aria-orientation="horizontal"
      aria-valuemin={TERMINAL_HEIGHT.min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      data-resizing={resizing}
      title="Drag or use arrow keys to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, height: value, current: value };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.current = clamp(drag.current.height + drag.current.y - event.clientY);
        onResize(drag.current.current);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const height = drag.current.current;
        drag.current = null;
        setResizing(false);
        onCommit(height);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        setResizing(false);
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          drag.current = null;
          setResizing(false);
          onCancel();
          return;
        }
        if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.shiftKey ? 48 : 16;
        const height =
          event.key === 'ArrowUp'
            ? value + step
            : event.key === 'ArrowDown'
              ? value - step
              : event.key === 'Home'
                ? TERMINAL_HEIGHT.min
                : event.key === 'End'
                  ? max
                  : undefined;
        if (height !== undefined) {
          event.preventDefault();
          onCommit(clamp(height));
        }
      }}
      onDoubleClick={() => onCommit(clamp(TERMINAL_HEIGHT.default))}
    />
  );
}

/** Closes the terminal `id`; one that ended already counts as closed. */
async function closeTerminal(gateway: GatewayClient, id: string) {
  try {
    await gateway.send('DELETE', `/api/terminals/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!isProblem(error, 'not-found')) throw error;
  }
}

/**
 * What Ctrl (Cmd on macOS) with `=`, `-` or `0` asks of the text's size, as the browser's own
 * zoom keys: a step up or down, or `0` for the saved size.
 */
function zoomStep(event: KeyboardEvent, apple: boolean): -1 | 0 | 1 | undefined {
  const modifier = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey) return undefined;
  if (
    event.key === '=' ||
    event.key === '+' ||
    event.code === 'Equal' ||
    event.code === 'NumpadAdd'
  )
    return 1;
  // Ctrl+Shift+- is the shell's: undo, in readline and Emacs.
  if (event.shiftKey && event.code === 'Minus') return undefined;
  if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') return -1;
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 0;
  return undefined;
}

/** What the extra keys type. */
const KEYS: { label: string; title: string; data: string }[] = [
  { label: 'Esc', title: 'Escape', data: '\x1b' },
  { label: 'Tab', title: 'Tab', data: '\t' },
  { label: '←', title: 'Left', data: '\x1b[D' },
  { label: '↑', title: 'Up', data: '\x1b[A' },
  { label: '↓', title: 'Down', data: '\x1b[B' },
  { label: '→', title: 'Right', data: '\x1b[C' },
  { label: '|', title: 'Pipe', data: '|' },
  { label: '~', title: 'Tilde', data: '~' },
  { label: '/', title: 'Slash', data: '/' },
  { label: '-', title: 'Dash', data: '-' },
];

function theme(dark: boolean) {
  return dark
    ? {
        background: '#171717',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        selectionBackground: '#3b4b6b',
      }
    : {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#1f2328',
        selectionBackground: '#c8d7f5',
      };
}

/**
 * A terminal, attached over a WebSocket and reattached when the connection drops. Out of sight,
 * while not `active`, it stays attached, so it hears its shell end.
 */
function TerminalView({
  id,
  active,
  fontSize,
  onZoom,
  onEnded,
}: {
  id: string;
  active: boolean;
  fontSize: number;
  /** Sizes the text for a while; nothing goes back to the saved size. */
  onZoom: (size: number | undefined) => void;
  onEnded: () => void;
}) {
  const runtime = useRuntime();
  const coarse = useMediaQuery('(pointer: coarse)');
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | undefined>(undefined);
  const ctrl = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [state, setState] = useState<'connecting' | 'open' | 'lost' | 'signed-out'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const terminal = useRef<{ xterm: Xterm; refit: () => void } | undefined>(undefined);
  const ended = useRef(onEnded);
  const zoom = useRef(onZoom);
  const shown = useRef(active);
  const initialFont = useRef(fontSize);
  useEffect(() => {
    ended.current = onEnded;
    zoom.current = onZoom;
    shown.current = active;
  });
  useEffect(() => {
    if (active) terminal.current?.xterm.focus();
  }, [active]);
  useEffect(() => {
    const current = terminal.current;
    if (!current || current.xterm.options.fontSize === fontSize) return;
    current.xterm.options.fontSize = fontSize;
    current.refit();
  }, [fontSize]);
  // The terminal itself, made once.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const dark = document.documentElement.classList.contains('dark');
    const xterm = new Xterm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: initialFont.current,
      scrollback: 5000,
      theme: theme(dark),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    // The page's theme changing, by Settings or the system's, changes the terminal's too.
    const themed = new MutationObserver(() => {
      xterm.options.theme = theme(document.documentElement.classList.contains('dark'));
    });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const resized = (step: number) =>
      Math.max(
        TERMINAL_FONT.min,
        Math.min(TERMINAL_FONT.max, (xterm.options.fontSize ?? TERMINAL_FONT.default) + step),
      );
    xterm.attachCustomKeyEventHandler((event) => {
      // The shortcut that shows and hides the terminal is the page's, not a key for the shell.
      if (matchesShortcut('toggleTerminal', event, appleKeyboard())) return false;
      // The keys that size the page size the terminal's text instead.
      const step = zoomStep(event, appleKeyboard());
      if (step === undefined) return true;
      event.preventDefault();
      if (event.type === 'keydown') zoom.current(step === 0 ? undefined : resized(step));
      return false;
    });
    const typed = xterm.onData((data) => {
      let text = data;
      // A Ctrl from the extra keys applies to the next key typed.
      if (ctrl.current && text.length === 1) {
        const code = text.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) text = String.fromCharCode(code & 0x1f);
        ctrl.current = false;
        setCtrlOn(false);
      }
      send({ type: 'input', data: text });
    });
    const resize = () => {
      // Hidden, it has no size to fit.
      if (!element.clientWidth || !element.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      send({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
    };
    terminal.current = { xterm, refit: resize };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    // Ctrl with the wheel, or a touchpad pinch, sizes the terminal's text rather than the page.
    // Small pinch steps add up to one size.
    let scrolled = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      scrolled += event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * 40;
      if (Math.abs(scrolled) < 50) return;
      const size = resized(scrolled < 0 ? 1 : -1);
      scrolled = 0;
      if (size !== xterm.options.fontSize) zoom.current(size);
    };
    element.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => {
      element.removeEventListener('wheel', wheel, { capture: true });
      themed.disconnect();
      observer.disconnect();
      typed.dispose();
      xterm.dispose();
      terminal.current = undefined;
    };
  }, []);
  function send(message: Record<string, unknown>) {
    const current = socket.current;
    if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify(message));
  }
  // The connection, made again whenever it drops while the page is in sight.
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // Tries again later, longer each time; out of sight, not until the page is in sight again.
    const schedule = () => {
      clearTimeout(retry);
      if (stopped || document.visibilityState !== 'visible') return;
      retry = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.max(0, failures - 1)));
    };
    // A connection refused before it opened says nothing of why: mekaweb is asked.
    const diagnose = async () => {
      try {
        const open = await runtime.gateway.get<Gateway['TerminalView'][]>('/api/terminals');
        if (stopped) return;
        if (!open.some((item) => item.id === id)) {
          stopped = true;
          clearTimeout(retry);
          ended.current();
        }
      } catch {
        // A sign-in that ended is handled by the client; anything else is tried again.
      }
    };
    const connect = () => {
      if (stopped) return;
      setState('connecting');
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${encodeURIComponent(id)}/socket`;
      const next = new WebSocket(url);
      next.binaryType = 'arraybuffer';
      socket.current = next;
      let replaying = true;
      let openedAt: number | undefined;
      next.onopen = () => {
        openedAt = Date.now();
        setState('open');
        // What comes first is the terminal's recent output, which redraws it from scratch.
        terminal.current?.xterm.reset();
        const xterm = terminal.current?.xterm;
        if (xterm)
          next.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
        if (shown.current) terminal.current?.xterm.focus();
      };
      next.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: string };
            if (message.type === 'exit') {
              stopped = true;
              ended.current();
            }
          } catch {
            // A message that does not read is ignored.
          }
          return;
        }
        replaying = false;
        terminal.current?.xterm.write(new Uint8Array(event.data));
      };
      next.onclose = (event) => {
        if (socket.current === next) socket.current = undefined;
        if (stopped) return;
        if (event.code === 4001) {
          stopped = true;
          setState('signed-out');
          return;
        }
        setState('lost');
        // Only a connection that lasted a while starts the waits over.
        failures = openedAt !== undefined && Date.now() - openedAt > 10_000 ? 1 : failures + 1;
        if (openedAt === undefined && replaying && failures >= 2) void diagnose();
        schedule();
      };
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && !socket.current && !stopped) {
        clearTimeout(retry);
        connect();
      }
    };
    connect();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', visible);
      socket.current?.close();
      socket.current = undefined;
    };
  }, [id, attempt, runtime]);
  return (
    <div className="terminal-view">
      {state !== 'open' && (
        <div className="terminal-status" role="status">
          <span className="muted small">
            {state === 'connecting'
              ? 'Connecting…'
              : state === 'lost'
                ? 'Disconnected; trying again.'
                : 'This device was signed out.'}
          </span>
          {state === 'lost' && (
            <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              Reconnect
            </Button>
          )}
        </div>
      )}
      <div ref={host} className="terminal-host" />
      {coarse && (
        <div className="terminal-keys" role="toolbar" aria-label="Extra keys">
          <button
            type="button"
            aria-pressed={ctrlOn}
            className={ctrlOn ? 'active' : undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              ctrl.current = !ctrl.current;
              setCtrlOn(ctrl.current);
              terminal.current?.xterm.focus();
            }}
          >
            Ctrl
          </button>
          {KEYS.map((key) => (
            <button
              type="button"
              key={key.title}
              title={key.title}
              aria-label={key.title}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                send({ type: 'input', data: key.data });
                terminal.current?.xterm.focus();
              }}
            >
              {key.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
