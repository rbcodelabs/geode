import { createBrowserHost } from "./browser-host";
import type { HostServices } from "./contracts";

let installedHost: HostServices | undefined;
let fallbackHost: HostServices | undefined;

export function installHostServices(host: HostServices): HostServices {
  installedHost = host;
  if (typeof window !== "undefined") window.hostServices = host;
  return host;
}

export function getHostServices(): HostServices {
  return installedHost ??
    (typeof window !== "undefined" ? window.hostServices : undefined) ??
    (fallbackHost ??= createBrowserHost());
}
