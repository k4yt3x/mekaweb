import { expect, it } from 'vitest';
import { base64url, bytes } from './webauthn';

it('round-trips URL-safe base64 without padding', () => {
  const data = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base64url(data);
  expect(encoded).toBe('AAEC-vv8_f7_');
  expect([...bytes(encoded)]).toEqual([...data]);
  expect([...bytes('AQ')]).toEqual([1]);
});
