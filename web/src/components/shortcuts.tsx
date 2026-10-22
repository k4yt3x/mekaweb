import type { RefObject } from 'react';
import { Keyboard } from 'lucide-react';
import { Dialog } from './ui/dialog';
import {
  appleKeyboard,
  shortcutAttribute,
  shortcutHint,
  shortcutKeys,
  shortcuts,
  type Shortcut,
} from './shortcut-keys';

/** The keyboard shortcuts, as an entry of the navigation below its pages. */
export function KeyboardShortcutsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="nav-item"
      data-keyboard-shortcuts
      onClick={onClick}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcutAttribute('showShortcuts')}
      title={`Keyboard shortcuts (${shortcutHint('showShortcuts')})`}
    >
      <Keyboard size={18} aria-hidden="true" />
      Shortcuts
    </button>
  );
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const apple = appleKeyboard();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="keyboard-shortcuts-dialog"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = returnFocus.current;
        if (target?.isConnected && target.getClientRects().length)
          target.focus({ preventScroll: true });
        else
          Array.from(
            document.querySelectorAll<HTMLElement>(
              'button[data-keyboard-shortcuts], button[aria-label="Open navigation"]',
            ),
          )
            .find((button) => button.getClientRects().length)
            ?.focus({ preventScroll: true });
      }}
    >
      <dl className="shortcut-list">
        {(Object.keys(shortcuts) as Shortcut[]).map((action) => (
          <div key={action}>
            <dt>{shortcuts[action].label}</dt>
            <dd aria-label={shortcutHint(action)}>
              {shortcutKeys(action, apple).map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <div className="shortcut-existing muted small">
        In the message box: Enter to send, Shift+Enter for a new line, Shift+Tab to cycle
        permissions.
      </div>
    </Dialog>
  );
}
