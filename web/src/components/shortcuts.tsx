import {
  appleKeyboard,
  shortcutHint,
  shortcutKeys,
  shortcuts,
  type Shortcut,
} from './shortcut-keys';

/** Every keyboard shortcut, with its keys on this keyboard. */
export function KeyboardShortcuts() {
  const apple = appleKeyboard();
  return (
    <div className="page">
      <header className="page-heading">
        <h1>Keyboard shortcuts</h1>
      </header>
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
    </div>
  );
}
