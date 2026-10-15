import { expect, it } from 'vitest';
import { supportsVersion } from './version';

it.each(['0.76.0', '0.76.1', '0.77.0', '0.100.0', '1.0.0', '0.76.0+build.1'])(
  'connects to meka %s',
  (version) => expect(supportsVersion(version)).toBe(true),
);
it.each([
  '',
  '0.59.0',
  '0.71.0',
  '0.75.0',
  '0.75.1',
  '0.76.0-rc.1',
  'unknown',
  '0.76',
  '0.76.0extra',
])('refuses older or unrecognized servers: %s', (version) =>
  expect(supportsVersion(version)).toBe(false),
);
