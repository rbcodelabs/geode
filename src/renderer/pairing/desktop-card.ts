import type { GeodeApi } from "../../main/preload";
import { PairingError } from "../../shared/pairing/errors";
import type { PairingBundle } from "../../shared/pairing/bundle";
import { renderQrSvg } from "./qr";

type PairingApi = NonNullable<GeodeApi["pairing"]>;
export interface DesktopCardDeps {
  api: PairingApi;
  /** Live desktop state to hand to the main process (provider config, vault, portable settings, credential). */
  build(): Promise<{ bundle: PairingBundle; hasCredential: boolean }>;
  now?: () => number;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Settings > Sync "Pair mobile device" card. Returns a disposer that cancels a live code and stops timers/subscriptions. */
export function renderPairingCard(parent: HTMLElement, deps: DesktopCardDeps): () => void {
  const now = deps.now ?? Date.now;
  const card = el("div", "setting-item sync-pairing-card"); card.setAttribute("data-pairing-card", "");
  const info = el("div", "setting-item-info");
  info.append(el("div", "setting-item-name", "Pair mobile device"), el("div", "setting-item-description", "Show a code that sets up sync on your phone: the hub, the shared vault and your editor, appearance, hotkey and daily-note settings. The code holds no password. Your phone gets the hub token over an encrypted connection and asks you to confirm before anything changes."));
  const control = el("div", "setting-item-control sync-pairing-control");
  const show = el("button", "mod-cta", "Show pairing code"); show.type = "button";
  const status = el("div", "sync-field-help"); status.setAttribute("data-pairing-status", ""); status.setAttribute("aria-live", "polite");
  const live = el("div", "sync-pairing-live"); live.hidden = true;
  control.append(show, status, live); card.append(info, control); parent.append(card);

  let timer: ReturnType<typeof setInterval> | undefined, active = false, disposed = false;
  const clear = () => { if (timer) clearInterval(timer); timer = undefined; live.replaceChildren(); live.hidden = true; active = false; show.disabled = false; };
  const stopEvents = deps.api.onEvent(event => {
    if (disposed || !active) return;
    clear();
    status.textContent = event.type === "redeemed" ? "Paired. Your phone received the setup and will ask you to confirm. If it didn't scan this code, someone else did: replace the hub token on your hub." :
      event.type === "expired" ? "That code expired. Show a new one when your phone is ready." :
      event.type === "too-many-attempts" ? "That code was cancelled after repeated failed attempts. Show a new one." : "Pairing code cancelled.";
  });
  const cancel = async () => { if (active) { await deps.api.cancel().catch(() => {}); } };
  show.addEventListener("click", () => {
    show.disabled = true; status.textContent = "Preparing...";
    void (async () => {
      try {
        const { bundle, hasCredential } = await deps.build();
        const reply = await deps.api.start(bundle);
        if (disposed) { await deps.api.cancel().catch(() => {}); return; }
        if (!reply.ok) { show.disabled = false; status.textContent = reply.error.message; return; }
        const { invitation, expiresAt } = reply.value;
        active = true; live.hidden = false; live.replaceChildren();
        const qr = el("div", "sync-pairing-qr"); qr.setAttribute("data-pairing-qr", ""); qr.style.maxWidth = "280px"; qr.style.background = "#fff"; qr.style.padding = "8px"; qr.style.borderRadius = "8px";
        qr.append(renderQrSvg(invitation, "Pairing code. Scan it with Geode on your phone."));
        const countdown = el("div", "sync-field-help"); countdown.setAttribute("data-pairing-countdown", "");
        const paint = () => { const left = expiresAt - now(); countdown.textContent = `Expires in ${clock(left)}. Single use.`; };
        paint(); timer = setInterval(paint, 1000);
        const stop = el("button", undefined, "Cancel code"); stop.type = "button"; stop.setAttribute("data-pairing-cancel", ""); stop.addEventListener("click", () => { void cancel().then(() => { if (active) { clear(); status.textContent = "Pairing code cancelled."; } }); });
        const details = el("details", "sync-pairing-paste"); details.append(el("summary", undefined, "Can't scan? Copy the code"));
        const code = el("code", "sync-pairing-code", invitation); code.setAttribute("data-pairing-code", ""); code.style.wordBreak = "break-all"; code.style.userSelect = "all";
        const copy = el("button", undefined, "Copy"); copy.type = "button"; copy.addEventListener("click", () => { void navigator.clipboard?.writeText(invitation).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Select and copy manually"; }); });
        details.append(code, copy);
        live.append(qr, countdown, stop, details);
        status.textContent = hasCredential ? "Scan this with Geode on your phone (Settings > Sync > Set up from desktop). It works once and expires, so don't share a photo of it." : "No hub token is saved on this device, so your phone will get the settings and will ask you for the token.";
      } catch (error) { show.disabled = false; status.textContent = error instanceof PairingError ? error.message : "Could not start pairing."; }
    })();
  });
  return () => { disposed = true; stopEvents(); if (timer) clearInterval(timer); if (active) void deps.api.cancel().catch(() => {}); };
}
