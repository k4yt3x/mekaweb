// meka 0.70.0 reshaped the API this client is built on, and 0.78.0 lets a turn run on without the
// request that started it, which every message to an idle session asks for. Every request type
// denies unknown fields, so older servers are refused at connect rather than half supported.
export const minimumVersion = '0.78.0';

/** The versions this release was checked against. A newer one connects, flagged in Settings. */
export const verifiedVersions = ['0.82.0'];

export function supportsVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 78;
}
