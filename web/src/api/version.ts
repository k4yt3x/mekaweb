import versions from './meka-versions.json';

// The meka versions this release supports, shared with mekaweb's server, which checks meka against
// them too. Every request type denies unknown fields, so older servers are refused at connect
// rather than half supported.
export const minimumVersion: string = versions.minimum;

function numbers(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function supportsVersion(version: string): boolean {
  const have = numbers(version);
  const need = numbers(minimumVersion);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index++) {
    const a = have[index] ?? 0;
    const b = need[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
