/** The main renderer may only load the exact app index URL. */
export function isAllowedAppNavigation(url: string, appIndexUrl: string): boolean {
  return url === appIndexUrl;
}
