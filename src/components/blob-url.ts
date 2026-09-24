import { useMemo, useSyncExternalStore } from 'react';

function blobUrlResource(blob: Blob | undefined) {
  let url: string | undefined;
  return {
    getSnapshot: () => url,
    subscribe: (changed: () => void) => {
      if (!blob) return () => {};
      const created = URL.createObjectURL(blob);
      url = created;
      changed();
      return () => {
        URL.revokeObjectURL(created);
        url = undefined;
      };
    },
  };
}

/** Own an object URL only while React subscribes to the browser resource. */
export function useBlobUrl(blob: Blob | undefined) {
  const resource = useMemo(() => blobUrlResource(blob), [blob]);
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot, () => undefined);
}
