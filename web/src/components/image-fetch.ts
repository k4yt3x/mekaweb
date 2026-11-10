import { ApiError, sessionPath, segment, type ApiClient } from '../api/client';

/** The bytes of an image a session's conversation holds, by the hash Meka names it by. */
export async function imageBlob(api: ApiClient, id: string, hash: string, signal: AbortSignal) {
  const blob = await api.blob(sessionPath(id) + '/blobs/' + segment(hash), undefined, signal);
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(blob.type))
    throw new Error('The server returned an unsupported image type.');
  return blob;
}

/**
 * Whether to ask again for an image a running turn's tool returned. Meka serves an image's bytes
 * once a saved message holds it, and saves a round's results only after all its calls complete,
 * so the first ask can come before the save.
 */
export function retryUnsavedImage(failures: number, error: unknown) {
  return failures < 5 && error instanceof ApiError && error.status === 404;
}
