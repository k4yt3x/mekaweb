import type { Schema } from '../api/client';

// meka passes the first five formats through and converts the rest to PNG.
const fileExtensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'hdr',
  'exr',
  'tga',
  'pnm',
  'ppm',
  'pgm',
  'pbm',
  'qoi',
  'dds',
  'ff',
];
export const imageAccept = ['image/*', ...fileExtensions.map((extension) => `.${extension}`)].join(
  ',',
);

const passThroughTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/** Browsers leave the type blank for formats they do not know, so the extension decides those. */
export function isAcceptedImage({ name, type }: Pick<File, 'name' | 'type'>) {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  // Any `image/*` would also admit SVG, HEIC, and AVIF, which meka refuses.
  return (
    passThroughTypes.includes(type) ||
    (extension !== undefined && fileExtensions.includes(extension))
  );
}

/** Refuse a batch with anything meka would not take before reading any of it. */
export function imageFiles<T extends Pick<File, 'name' | 'type'>>(files: T[]) {
  const other = files.find((file) => !isAcceptedImage(file));
  if (other) throw new Error(`${other.name} is not an image format meka accepts.`);
  return files;
}

/** Files to attach from a paste, or none when it holds text for the input to take. */
export function pastedFiles<T>({
  files,
  types,
}: {
  files: ArrayLike<T>;
  types: readonly string[];
}) {
  // Spreadsheets and word processors copy a picture of the selection beside its text.
  return files.length && !types.includes('text/plain') ? Array.from(files) : undefined;
}

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
