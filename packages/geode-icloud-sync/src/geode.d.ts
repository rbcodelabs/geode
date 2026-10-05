// Minimal ambient surface of `require("geode")` that this plugin uses.
declare module "geode" {
  import type { SyncProvider } from "../../../src/renderer/sync/types";
  export class Plugin {
    registerSyncProvider(provider: SyncProvider): void;
    onload(): void | Promise<void>;
  }
  export class SyncPreconditionError extends Error {}
}
