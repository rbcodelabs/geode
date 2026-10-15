/** Private parser-free facade. Transport and current ownership are explicit. */
export interface ImageSourceFile { readonly path: string; readonly extension: string }
export interface ImageSourceContext<T extends ImageSourceFile> {
  readonly source: string;
  readonly owner: T;
  readonly vault: object;
  readonly root: string;
  readonly snapshot: object;
  currentVault(): object;
  currentRoot(): string;
  currentSnapshot(): object;
  fileByPath(path: string): T | null;
  resolve(target: string, sourcePath: string): T | null;
}
export interface OwnedImageOccurrence<T extends ImageSourceFile = ImageSourceFile> {
  readonly key: object;
  readonly from: number;
  readonly to: number;
  readonly authoredTarget: string;
  readonly target: string;
  readonly label: string;
  readonly title: string;
  readonly linked: boolean;
  readonly file: T | null;
  readonly resolvedPath: string | null;
  readonly status: "ready" | "missing" | "error";
}
export interface OwnedImageProjection<T extends ImageSourceFile = ImageSourceFile> {
  readonly status: "ready";
  readonly source: string;
  readonly occurrences: readonly OwnedImageOccurrence<T>[];
  readonly issues: readonly { from: number; to: number; reason: string }[];
}
export type ImageProjectionResult<T extends ImageSourceFile> = OwnedImageProjection<T> | {
  status: "unsupported"; reason: "source-limit" | "non-lf-source" | "stale-owner";
};

export { projectPackedOwnedImages as projectOwnedImages, isImageProjectionCurrent } from "./async-source";
