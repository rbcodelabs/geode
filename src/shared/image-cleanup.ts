/** Private main/adapter contract; no public SDK export or installed IPC channel. */
export class ImageCleanupUncertainError extends AggregateError {
  constructor(errors: unknown[]) { super(errors, "Image resource cleanup is uncertain."); this.name = "ImageCleanupUncertainError"; }
}
/** Trusted host reply: future bridge validates this tag without trusting cloned Error prototypes. */
export interface ImageCleanupFailure { kind: "cleanup-uncertain"; error: unknown }
