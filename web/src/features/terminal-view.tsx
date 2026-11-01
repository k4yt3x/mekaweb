import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useRuntime } from '../connections/context';
import { Button } from '../components/ui/button';
import { useMediaQuery } from '../components/media-query';
import { TERMINAL_FONT } from '../connections/storage';
import { appleKeyboard, matchesShortcut, type Shortcut } from '../components/shortcut-keys';
import { followZoomWheel, zoomStep } from '../components/text-zoom';
import type { Gateway } from '../api/gateway';

/** The page's shortcuts that reach it from the terminal. */
const PAGE_SHORTCUTS: readonly Shortcut[] = [
  'toggleTerminal',
  'newTerminal',
  'toggleFiles',
  'toggleContext',
  'toggleTasks',
  'toggleSchedules',
];

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
 * while not `active`, it stays attached, so it hears its shell end. Shown, it takes the keyboard
 * when `takeFocus` says it was asked for, as `asked` counts, not when it shows by itself, as
 * with a session opened.
 */
export function TerminalView({
  id,
  active,
  asked,
  fontSize,
  takeFocus,
  onZoom,
  onEnded,
}: {
  id: string;
  active: boolean;
  asked: number;
  fontSize: number;
  takeFocus: () => boolean;
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
  const focus = useRef(takeFocus);
  const initialFont = useRef(fontSize);
  useEffect(() => {
    ended.current = onEnded;
    zoom.current = onZoom;
    focus.current = takeFocus;
  });
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
      // The shortcuts that show the terminal and the panels in its place are the page's, not keys
      // for the shell.
      if (PAGE_SHORTCUTS.some((action) => matchesShortcut(action, event, appleKeyboard())))
        return false;
      // Ctrl+Shift+- is the shell's: undo, in readline and Emacs.
      if (event.shiftKey && event.code === 'Minus') return true;
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
    const stopWheel = followZoomWheel(element, (step) => {
      const size = resized(step);
      if (size !== xterm.options.fontSize) zoom.current(size);
    });
    return () => {
      stopWheel();
      themed.disconnect();
      observer.disconnect();
      typed.dispose();
      xterm.dispose();
      terminal.current = undefined;
    };
  }, []);
  // Declared after the terminal is made, so one shown as it starts can take the keyboard.
  useEffect(() => {
    if (active && focus.current()) terminal.current?.xterm.focus();
  }, [active, asked]);
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
