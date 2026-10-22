import { expect, it } from 'vitest';
import {
  imageAccept,
  imageFilename,
  imageFiles,
  inputImageBlob,
  isAcceptedImage,
  pastedFiles,
} from './image-input';

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

it('accepts the formats meka passes through or converts, by type or extension', () => {
  expect(isAcceptedImage({ name: 'image.png', type: 'image/png' })).toBe(true);
  expect(isAcceptedImage({ name: 'photo', type: 'image/jpeg' })).toBe(true);
  expect(isAcceptedImage({ name: 'scan.QOI', type: '' })).toBe(true);
  expect(isAcceptedImage({ name: 'page.tiff', type: 'image/tiff' })).toBe(true);
  expect(isAcceptedImage({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false);
  expect(isAcceptedImage({ name: 'photo.heic', type: 'image/heic' })).toBe(false);
  expect(isAcceptedImage({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false);
  expect(isAcceptedImage({ name: 'ff', type: '' })).toBe(false);
  expect(imageAccept).toMatch(/^image\/\*,\.png,.*,\.ff$/);
});

it('refuses a whole batch that holds anything meka would not take', () => {
  const images = [{ name: 'one.png', type: 'image/png' }];
  expect(imageFiles(images)).toBe(images);
  expect(() => imageFiles([...images, { name: 'notes.pdf', type: 'application/pdf' }])).toThrow(
    'notes.pdf is not an image format meka accepts.',
  );
});

it('attaches pasted files unless the paste also holds text for the input', () => {
  const image = { name: 'image.png', type: 'image/png' };
  expect(pastedFiles({ files: [image], types: ['Files'] })).toEqual([image]);
  // Spreadsheets copy a picture of the selection beside its text; a browser's Copy Image does not.
  expect(pastedFiles({ files: [image], types: ['text/plain', 'text/html', 'Files'] })).toBe(
    undefined,
  );
  expect(pastedFiles({ files: [image], types: ['text/html', 'Files'] })).toEqual([image]);
  expect(pastedFiles({ files: [], types: ['text/plain'] })).toBe(undefined);
});
