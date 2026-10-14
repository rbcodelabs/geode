/**
 * The running Geode version on runtimes with no main process to ask (mobile).
 * Injected at build time from package.json by the mobile esbuild target; any
 * other bundle gets "0.0.0", which fails every minimumGeodeVersion gate closed.
 */
declare const __GEODE_APP_VERSION__: string | undefined;

export const GEODE_APP_VERSION: string =
  typeof __GEODE_APP_VERSION__ === "string" ? __GEODE_APP_VERSION__ : "0.0.0";
