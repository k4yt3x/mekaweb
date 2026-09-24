import { expect, it } from 'vitest';
import { supportsSessionOrganization } from './version';

it.each(['0.64.0', '0.64.1', '0.65.0', '0.100.0', '1.0.0', '0.64.0+build.1'])(
  'enables session organization for %s',
  (version) => expect(supportsSessionOrganization(version)).toBe(true),
);
it.each([undefined, '', '0.59.0', '0.63.9', '0.64.0-rc.1', 'unknown', '0.64', '0.64.0extra'])(
  'does not send new operations to unrecognized or older servers: %s',
  (version) => expect(supportsSessionOrganization(version)).toBe(false),
);
