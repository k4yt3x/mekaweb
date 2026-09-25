/**
 * Native :focus-visible can follow scripted focus moves (dialogs and clipboard
 * fallbacks). Keep those moves quiet during pointer use, without moving/blurring
 * focus or overriding native visibility when the input method is unknown.
 */
export function trackFocusInput() {
  const root = document.documentElement;
  function set(method: 'keyboard' | 'pointer') {
    if (root.dataset.focusInput !== method) root.dataset.focusInput = method;
  }
  const pointer = () => set('pointer');
  function keyboard(event: KeyboardEvent) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing ||
      ['Alt', 'Control', 'Meta', 'Shift', 'CapsLock', 'Escape'].includes(event.key)
    )
      return;
    // Tab can enter the document from browser chrome before we see keydown.
    if (event.key === 'Tab') {
      set('keyboard');
      return;
    }
    if (event.type === 'keyup') return;
    const target = event.target;
    const editing =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(
          target.type,
        )) ||
      (target instanceof HTMLElement && target.isContentEditable);
    // Typing is not keyboard navigation. Escape preserves the opening modality,
    // so dismissing a mouse-opened dialog does not outline its return target.
    if (!editing) set('keyboard');
  }
  function virtualClick(event: MouseEvent) {
    // Keyboard and assistive-technology activations have no pointer click count.
    // Ignore script .click(), such as the hidden file input used by Attach.
    if (
      event.isTrusted &&
      event.detail === 0 &&
      (!(event instanceof PointerEvent) || !event.pointerType)
    )
      set('keyboard');
  }
  function visibility() {
    if (document.visibilityState === 'hidden') delete root.dataset.focusInput;
  }
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('wheel', pointer, { capture: true, passive: true });
  document.addEventListener('keydown', keyboard, true);
  document.addEventListener('keyup', keyboard, true);
  document.addEventListener('click', virtualClick, true);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('wheel', pointer, true);
    document.removeEventListener('keydown', keyboard, true);
    document.removeEventListener('keyup', keyboard, true);
    document.removeEventListener('click', virtualClick, true);
    document.removeEventListener('visibilitychange', visibility);
    delete root.dataset.focusInput;
  };
}
