import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Whether the page is dark, as Settings or the system's theme makes it. */
export function useDarkTheme() {
  return useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'));
}
