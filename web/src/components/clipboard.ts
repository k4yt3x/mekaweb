export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* The permission can be denied even when the modern API is present. */
    }
  }
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand('copy'))
      throw new Error('Copy was blocked by the browser. Select the text and copy it manually.');
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
