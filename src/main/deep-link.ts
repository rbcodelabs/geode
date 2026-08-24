export interface GeodeDeepLink {
  action: string;
  params: Record<string, string>;
}

export function parseGeodeDeepLink(value: string): GeodeDeepLink | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "geode:" || !url.hostname) return null;
    const action = decodeURIComponent(url.hostname);
    return {
      action,
      params: { ...Object.fromEntries(url.searchParams), action },
    };
  } catch {
    return null;
  }
}

export class DeepLinkDispatcher {
  private pending: GeodeDeepLink[] = [];
  private send: ((link: GeodeDeepLink) => void) | null = null;

  accept(value: string): boolean {
    const link = parseGeodeDeepLink(value);
    if (!link) return false;
    if (this.send) this.send(link);
    else this.pending.push(link);
    return true;
  }

  acceptArgv(argv: string[]): boolean {
    const value = argv.find((arg) => arg.startsWith("geode://"));
    return value ? this.accept(value) : false;
  }

  attach(send: (link: GeodeDeepLink) => void): void {
    this.send = send;
    for (const link of this.pending.splice(0)) send(link);
  }
}
