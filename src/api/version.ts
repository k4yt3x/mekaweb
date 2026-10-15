// meka 0.70.0 reshaped the API this client is built on, and 0.76.0 renames a session's `cwd` to
// `working_directory` in every request and record, so older servers are refused at connect rather
// than half supported.
export const minimumVersion = '0.76.0';

/** The versions this release was checked against. A newer one connects, flagged in Settings. */
export const verifiedVersions = ['0.76.0'];

export function supportsVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 76;
}
