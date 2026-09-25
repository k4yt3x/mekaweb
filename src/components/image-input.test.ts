import { expect, it } from 'vitest';
import { imageFilename, inputImageBlob } from './image-input';

it.each([
  ['\x89PNG\r\n\x1a\n', 'image/png'],
  ['\xff\xd8\xff\xe0', 'image/jpeg'],
  ['GIF89a', 'image/gif'],
  ['GIF87a', 'image/gif'],
  ['RIFF\x10\x00\x00\x00WEBP', 'image/webp'],
  ['BM\x10\x00\x00\x00', 'image/bmp'],
  ['\x00\x00\x01\x00', 'image/x-icon'],
])('identifies %j from bytes even when the MIME hint is absent or wrong', async (header, type) => {
  const binary = header + '\x00\x80\xff';
  const blob = inputImageBlob({ data: btoa(binary), media_type: 'application/octet-stream' });
  expect(blob.type).toBe(type);
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(
    [...binary].map((char) => char.charCodeAt(0)),
  );
});

it('never embeds active content based on a claimed raster MIME type', async () => {
  const content =
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>';
  const blob = inputImageBlob({ data: btoa(content), media_type: 'image/png' });
  expect(blob.type).toBe('application/octet-stream');
  expect(await blob.text()).toBe(content);
});

it('rejects malformed or excessively large base64 without mutating the submission', () => {
  const image = { data: '%invalid', media_type: 'image/png' };
  expect(() => inputImageBlob(image)).toThrow();
  expect(image).toEqual({ data: '%invalid', media_type: 'image/png' });
  expect(() => inputImageBlob({ data: 'A'.repeat(5_000_001), media_type: 'image/png' })).toThrow(
    'size limit',
  );
});

it('uses safe download extensions for decoded images and unsupported formats', () => {
  expect(imageFilename('image/jpeg')).toBe('attachment.jpg');
  expect(imageFilename('image/png')).toBe('attachment.png');
  expect(imageFilename('application/octet-stream')).toBe('attachment.bin');
});
