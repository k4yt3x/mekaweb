/** An atomic, bounded claim shared by foreground pages and browser-notification delivery. */
export function claimNotification(
  tag: string,
  scope: string,
  database: IDBFactory = indexedDB,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    const finish = (error: unknown, fresh = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        try {
          transaction?.abort();
        } catch {
          /* The transaction may already have ended. */
        }
      }
      db?.close();
      if (error) reject(error);
      else resolve(fresh);
    };
    const timeout = setTimeout(() => finish(new Error('Notification storage timed out.')), 5000);
    try {
      const opening = database.open('mekaweb-notifications:' + scope, 1);
      opening.onupgradeneeded = () => {
        if (settled) {
          opening.transaction?.abort();
          return;
        }
        opening.result.createObjectStore('seen', { keyPath: 'tag' });
      };
      opening.onblocked = () => finish(new Error('Notification storage is blocked.'));
      opening.onerror = () => finish(opening.error ?? new Error('Notification storage failed.'));
      opening.onsuccess = () => {
        db = opening.result;
        if (settled) {
          db.close();
          return;
        }
        try {
          transaction = db.transaction('seen', 'readwrite');
          const store = transaction.objectStore('seen');
          const now = Date.now();
          let fresh = false;
          transaction.oncomplete = () => finish(undefined, fresh);
          transaction.onabort = () =>
            finish(transaction?.error ?? new Error('Notification claim was aborted.'));
          const lookup = store.get(tag);
          lookup.onsuccess = () => {
            if (settled || lookup.result) return;
            try {
              fresh = true;
              store.put({ tag, time: now });
              const all = store.getAll();
              all.onsuccess = () => {
                if (settled) return;
                try {
                  const records = (all.result as { tag: string; time: number }[]).sort((a, b) =>
                    a.tag === tag ? -1 : b.tag === tag ? 1 : b.time - a.time,
                  );
                  for (const [index, record] of records.entries())
                    if (index >= 500 || record.time < now - 86_400_000) store.delete(record.tag);
                } catch (error) {
                  finish(error);
                }
              };
            } catch (error) {
              finish(error);
            }
          };
        } catch (error) {
          finish(error);
        }
      };
    } catch (error) {
      finish(error);
    }
  });
}
