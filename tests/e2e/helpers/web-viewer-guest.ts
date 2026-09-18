import { expect, type Page } from "@playwright/test";

/**
 * Helpers for driving Web Viewer `<webview>` guests from an Electron E2E test.
 *
 * Not a spec file, so Playwright's default `testMatch` (`**´/*.spec.ts`) does
 * not collect it.
 *
 * A guest is a separate WebContents that Playwright's `Page` handle does not
 * reach, so the only way in is the `<webview>` element's own
 * `executeJavaScript(code, userGesture)`. Its `userGesture` argument is also
 * the only way to give a click real user activation, which matters for
 * anything Chromium gates on it.
 */

/** Open a new Web Viewer tab and return once the leaf's view state is set. */
export async function openWebViewerTab(window: Page, url: string): Promise<void> {
  await window.evaluate(async (target) => {
    const leaf = (window as unknown as { app: any }).app.workspace.getLeaf(true);
    await leaf.setViewState({ type: "webviewer", active: true, state: { url: target } });
  }, url);
}

/**
 * Run code in a guest's MAIN world, choosing the guest by a substring of its
 * committed URL. Background tabs stay mounted (see `TabGroup.revealActiveLeaf`),
 * so this reaches every open Web Viewer tab, not only the visible one.
 */
export async function inGuest<T>(
  window: Page,
  urlPart: string,
  code: string,
  userGesture = false,
): Promise<T> {
  return window.evaluate(async (args) => {
    const guests = [...document.querySelectorAll("webview.web-view-frame")] as any[];
    const guest = guests.find((el) => {
      try { return String(el.getURL()).includes(args.urlPart); } catch { return false; }
    });
    if (!guest) throw new Error(`no Web Viewer guest matching ${args.urlPart}`);
    return await guest.executeJavaScript(args.code, args.userGesture);
  }, { urlPart, code, userGesture }) as Promise<T>;
}

/**
 * Block until a guest for `urlPart` exists **and its document is usable**.
 *
 * Waiting on the `.web-view-frame` selector alone is not enough and was a real
 * source of flakes: the element is in the DOM as soon as the view is
 * constructed, but `WebView` boots the guest on `about:blank` and only then
 * navigates to the requested URL (see `BOOTSTRAP_URL` in web-view.ts). Calling
 * `executeJavaScript` in that window fails with
 * `GUEST_VIEW_MANAGER_CALL: Script failed to execute`, and mid-navigation it
 * can fail again. So poll the guest itself, tolerate the throw, and require
 * both that the committed URL is the one we asked for and that parsing has
 * finished.
 */
export async function waitForGuest(window: Page, urlPart: string, timeout = 20_000): Promise<void> {
  await expect.poll(
    async () => inGuest<string>(
      window,
      urlPart,
      "location.href + '|' + document.readyState",
    ).catch(() => null),
    { timeout },
  ).toMatch(new RegExp(`${escapeForRegExp(urlPart)}.*\\|complete$`));
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The URL of the guest in the *visible* center tab, or null when the active
 * tab is not a Web Viewer.
 *
 * Activation is a CSS state, not a mounting state: `TabGroup.revealActiveLeaf`
 * leaves every revealed leaf in the content host and marks only one
 * `mod-active`. So "which guest is the user looking at" has to be read off that
 * class — counting mounted guests would report every open tab.
 */
export function activeWebViewerUrl(window: Page): Promise<string | null> {
  return window.evaluate(() => {
    const el = document.querySelector(
      ".workspace-split.mod-root .workspace-leaf.mod-active webview.web-view-frame",
    ) as { getURL(): string } | null;
    try { return el ? String(el.getURL()) : null; } catch { return null; }
  });
}

/** Bring the Web Viewer tab whose committed URL contains `urlPart` to the front. */
export async function activateWebViewerTab(window: Page, urlPart: string): Promise<void> {
  await window.evaluate((part) => {
    let target: any = null;
    (window as unknown as { app: any }).app.workspace.iterateAllLeaves((leaf: any) => {
      if (target || leaf.view?.viewType !== "webviewer") return;
      const guest = leaf.leafEl?.querySelector?.("webview.web-view-frame") as { getURL(): string } | null;
      try { if (guest && String(guest.getURL()).includes(part)) target = leaf; } catch { /* not navigated yet */ }
    });
    if (!target) throw new Error(`no Web Viewer leaf matching ${part}`);
    target.group.setActiveLeaf(target);
  }, urlPart);
}

/** How many Web Viewer tabs are open, counted from the workspace, not the DOM. */
export function webViewerLeafCount(window: Page): Promise<number> {
  return window.evaluate(() => {
    let count = 0;
    (window as unknown as { app: any }).app.workspace.iterateAllLeaves((leaf: any) => {
      if (leaf.view?.viewType === "webviewer") count += 1;
    });
    return count;
  });
}
