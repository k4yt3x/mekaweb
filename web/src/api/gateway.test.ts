import { afterEach, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway';

afterEach(() => vi.unstubAllGlobals());

it('builds same-origin API addresses and refuses paths that would resolve elsewhere', () => {
  vi.stubGlobal('location', new URL('https://mekaweb.test/'));
  const gateway = new GatewayClient();
  expect(gateway.url('/api/terminals/abc/socket')).toBe(
    'https://mekaweb.test/api/terminals/abc/socket',
  );
  expect(gateway.url('/api/files/list', { root: 'work', path: 'a b' })).toBe(
    'https://mekaweb.test/api/files/list?root=work&path=a+b',
  );
  for (const path of [
    '/api/terminals/../socket',
    '/api/terminals/%2e%2E/socket',
    '/api/./x',
    '/api/x?y=1',
    '/api/x#y',
    '/meka/v1/x',
  ])
    expect(() => gateway.url(path), path).toThrow('Invalid API path.');
});
