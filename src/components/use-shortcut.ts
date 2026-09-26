import { useEffect, useEffectEvent } from 'react';
import { appleKeyboard, matchesShortcut, shortcutAllowed, type Shortcut } from './shortcut-keys';

export function useShortcut(action: Shortcut, run: () => void, enabled = true) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      !matchesShortcut(action, event, appleKeyboard())
    )
      return;
    // Do not reject getModifierState('AltGraph'): Firefox also sets it for ordinary
    // Ctrl+Alt on Windows and Option on macOS. Match the produced key and modifiers instead.
    const target = event.target;
    const editing =
      target instanceof Element &&
      Boolean(
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"]',
        ),
      );
    // Preserve paragraph navigation and select controls, particularly Option+arrows on macOS.
    if (editing && (action === 'previousSession' || action === 'nextSession')) return;
    event.preventDefault();
    const overlay = Boolean(
      document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
      ),
    );
    if (
      !shortcutAllowed(action, {
        enabled,
        composing: false,
        repeated: event.repeat,
        overlay,
        editing,
        helpOpen: Boolean(document.querySelector('.keyboard-shortcuts-dialog[data-state="open"]')),
      })
    )
      return;
    document.documentElement.dataset.focusInput = 'keyboard';
    run();
  });
  useEffect(() => {
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [action]);
}
