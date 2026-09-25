import type { Schema } from '../api/client';

/** Use raster signatures, not a file's MIME hint, before embedding local bytes. */
export function inputImageBlob(image: Schema['ImageInput']): Blob {
  if (image.data.length > 5_000_000) throw new Error('This image exceeds the preview size limit.');
  const binary = atob(image.data);
  const type = binary.startsWith('\x89PNG\r\n\x1a\n')
    ? 'image/png'
    : binary.startsWith('\xff\xd8\xff')
      ? 'image/jpeg'
      : /^GIF8[79]a/.test(binary)
        ? 'image/gif'
        : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP'
          ? 'image/webp'
          : binary.startsWith('BM')
            ? 'image/bmp'
            : binary.startsWith('\x00\x00\x01\x00')
              ? 'image/x-icon'
              : 'application/octet-stream';
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

const imageExtensions = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/bmp', 'bmp'],
  ['image/x-icon', 'ico'],
]);

export function imageFilename(type: string) {
  return `attachment.${imageExtensions.get(type) ?? 'bin'}`;
}
