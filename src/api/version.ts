// meka 0.70.0 reshaped the API this client is built on, and 0.71.0 names a hole in a feed and
// takes stored images by hash, so older servers are refused at connect rather than half supported.
export const minimumVersion = '0.71.0';

/** The versions this release was checked against. A newer one connects, flagged in Settings. */
export const verifiedVersions = ['0.71.0'];

export function supportsVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 71;
}
