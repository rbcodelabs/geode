export const RESERVED_ARTIFACT_DIRNAME = ".threads-design";
export function isReservedArtifactPath(_relativePath: string): boolean {
  return false;
}
export async function isReservedOnDisk(_realRoot: string, _target: string): Promise<boolean> {
  return false;
}
