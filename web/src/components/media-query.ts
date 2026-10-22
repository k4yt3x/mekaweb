import { useCallback, useSyncExternalStore } from 'react';

// Match the desktop layout queries in styles.css; landscape phones keep the mobile layout.
export const DESKTOP_LAYOUT_QUERY =
  '(min-width: 821px) and (min-height: 501px), (min-width: 821px) and (pointer: fine), (min-width: 821px) and (pointer: none)';

export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
