/** The largest image meka takes in a message: it refuses a larger one rather than shrinking it. */
export const MEKA_IMAGE_BYTES = 3_750_000;

/** The shortest long edge a PNG is shrunk to before it becomes a JPEG, which keeps text sharp. */
const PNG_FLOOR = 1024;

type Encode = (width: number, height: number, type: string, quality: number) => Promise<Blob>;

/**
 * Shrinks a picture of `width` by `height`, `size` bytes of `type`, until it fits `limit`: its
 * dimensions go down a step at a time, keeping its format where it can. A PNG becomes a JPEG
 * only when it would have to go below `PNG_FLOOR` pixels on its long edge; other formats than
 * PNG, JPEG and WebP become PNG first.
 */
export async function shrink(
  source: { width: number; height: number; size: number; type: string },
  encode: Encode,
  limit = MEKA_IMAGE_BYTES,
): Promise<Blob> {
  let type = ['image/png', 'image/jpeg', 'image/webp'].includes(source.type)
    ? source.type
    : 'image/png';
  // Bytes go roughly with pixels, so the first guess scales by the square root.
  let scale = Math.min(1, Math.sqrt(limit / source.size) * 0.95);
  for (let attempt = 0; attempt < 12; attempt++) {
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const blob = await encode(width, height, type, 0.9);
    if (blob.size <= limit) return blob;
    const next = scale * Math.min(0.9, Math.sqrt(limit / blob.size) * 0.95);
    if (type === 'image/png' && Math.max(source.width, source.height) * next < PNG_FLOOR) {
      type = 'image/jpeg';
      scale = Math.min(1, scale);
      continue;
    }
    scale = next;
  }
  throw new Error('This image could not be made small enough for meka.');
}

/** `file` shrunk to fit meka's limit, in the browser, without its metadata. */
export async function shrinkFile(file: Blob, limit = MEKA_IMAGE_BYTES): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    return await shrink(
      { width: bitmap.width, height: bitmap.height, size: file.size, type: file.type },
      async (width, height, type, quality) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser cannot shrink images.');
        if (type === 'image/jpeg') {
          // JPEG has no transparency; white is what a transparent picture is usually seen on.
          context.fillStyle = '#fff';
          context.fillRect(0, 0, width, height);
        }
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        return new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
            type,
            quality,
          ),
        );
      },
      limit,
    );
  } finally {
    bitmap.close();
  }
}
