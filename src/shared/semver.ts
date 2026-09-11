interface ParsedVersion { core: [string, string, string]; prerelease: string[] }

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length || !right.length) return left.length ? -1 : right.length ? 1 : 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      return compareNumericIdentifier(a, b);
    }
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function isMinimumGeodeVersionMet(current: string, minimum: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericIdentifier(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison > 0;
  }
  return comparePrerelease(left.prerelease, right.prerelease) >= 0;
}
