// /info has no feature flags for these additions. Gate writes as well as search: older
// servers may silently ignore unknown PATCH fields and still return success.
export function supportsSessionOrganization(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version ?? '');
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 64;
}

export const supportedVersions = [
  '0.59.0',
  '0.60.0',
  '0.61.0',
  '0.62.0',
  '0.63.0',
  '0.64.0',
  '0.64.1',
  '0.65.0',
];
