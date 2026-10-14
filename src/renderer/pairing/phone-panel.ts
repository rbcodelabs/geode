import { PairingError } from "../../shared/pairing/errors";
import type { PairingBundle } from "../../shared/pairing/bundle";
import { PORTABLE_CATEGORIES } from "../../shared/pairing/bundle";
import { runPairingFlow, type PairingFlowDeps, type PairingOutcome } from "./flow";
import { ScannerError, type PairingScanner } from "./scanner";

export interface PhonePanelDeps {
  flow: Omit<PairingFlowDeps, "confirm" | "onStep">;
  scanner: PairingScanner | null;
  /** Called after a successful apply (for example to activate the provider and redraw Settings). */
  onApplied(outcome: Extract<PairingOutcome, { status: "applied" }>): void | Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const CATEGORY_LABELS: Record<string, string> = { editor: "Editor", appearance: "Appearance", hotkeys: "Hotkeys", dailyNotes: "Daily notes" };

/** Human sentence for a failure. Never includes payload content. */
export function describePairingError(error: unknown): string {
  if (error instanceof PairingError || error instanceof ScannerError) return error.message;
  return "Pairing failed. Nothing was changed.";
}

/** Settings > Sync "Set up from desktop" (phone). Scan or paste, confirm, apply. Returns a disposer. */
export function renderPhonePairingPanel(parent: HTMLElement, deps: PhonePanelDeps): () => void {
  const card = el("div", "setting-item sync-pairing-phone"); card.setAttribute("data-pairing-phone", "");
  const info = el("div", "setting-item-info");
  info.append(el("div", "setting-item-name", "Set up from desktop"), el("div", "setting-item-description", "On your computer open Settings > Sync > Pair mobile device, then scan the code here or paste it. You'll confirm before anything is saved."));
  const control = el("div", "setting-item-control sync-pairing-control");
  const status = el("div", "sync-field-help"); status.setAttribute("data-pairing-phone-status", ""); status.setAttribute("aria-live", "polite");
  const preview = el("div", "sync-pairing-preview"); preview.hidden = true;
  const sheet = el("div", "sync-pairing-confirm"); sheet.hidden = true; sheet.setAttribute("role", "group"); sheet.setAttribute("aria-label", "Confirm pairing");
  const scan = el("button", "mod-cta", "Scan code"); scan.type = "button"; scan.hidden = !deps.scanner;
  const paste = el("input"); paste.type = "text"; paste.placeholder = "Paste pairing code"; paste.setAttribute("aria-label", "Pairing code"); paste.autocomplete = "off"; paste.spellcheck = false; paste.autocapitalize = "off";
  const go = el("button", undefined, "Set up"); go.type = "button"; go.setAttribute("data-pairing-paste-go", "");
  const row = el("div", "sync-setup-buttons"); row.append(scan, paste, go);
  control.append(row, status, preview, sheet); card.append(info, control); parent.append(card);

  let busy = false, scanAbort: AbortController | undefined, disposed = false, settle: ((ok: boolean) => void) | undefined;
  const setBusy = (value: boolean) => { busy = value; scan.disabled = go.disabled = paste.disabled = value; };
  const confirmSheet = (bundle: PairingBundle) => new Promise<boolean>(resolve => {
    const url = new URL(bundle.provider.config.url);
    const lines: Array<[string, string]> = [["From", bundle.from || "your computer"], ["Hub", url.host], ["Shared vault", bundle.vault ? `${bundle.vault.name} (${bundle.vault.id.slice(0, 8)})` : "None yet"],
      ["Settings", PORTABLE_CATEGORIES.filter(key => bundle.portable[key] !== undefined).map(key => CATEGORY_LABELS[key]).join(", ") || "None"],
      ["Hub token", bundle.credential ? "Saved in this device's Keychain" : "Not included. You'll enter it yourself"]];
    sheet.replaceChildren(el("div", "setting-item-name", "Set up sync with this computer?"));
    for (const [label, value] of lines) { const line = el("div", "sync-field-help"); line.append(el("b", undefined, `${label}: `), document.createTextNode(value)); sheet.append(line); }
    sheet.append(el("div", "sync-field-help", "This doesn't start syncing. You'll review the first sync plan next. A token you accept here stays valid until it's replaced on the hub."));
    const cancel = el("button", undefined, "Cancel"); cancel.type = "button"; cancel.setAttribute("data-pairing-decline", "");
    const accept = el("button", "mod-cta", "Set up"); accept.type = "button"; accept.setAttribute("data-pairing-accept", "");
    const buttons = el("div", "sync-setup-buttons"); buttons.append(cancel, accept); sheet.append(buttons); sheet.hidden = false;
    const done = (ok: boolean) => { settle = undefined; sheet.hidden = true; sheet.replaceChildren(); resolve(ok); };
    settle = done; cancel.addEventListener("click", () => done(false)); accept.addEventListener("click", () => done(true)); accept.focus();
  });
  const run = async (text: string) => {
    if (busy) return; setBusy(true);
    const steps = { checking: "Checking the code...", connecting: "Connecting to your computer...", confirming: "Waiting for your confirmation.", applying: "Saving..." } as const;
    try {
      const outcome = await runPairingFlow(text, { ...deps.flow, confirm: confirmSheet, onStep: step => { if (!disposed) status.textContent = steps[step]; } });
      if (disposed) return;
      if (outcome.status === "declined") { status.textContent = "Cancelled. Nothing was changed. Show a new code on your computer to try again."; paste.value = ""; return; }
      const { report } = outcome;
      const skipped = report.skipped.length ? ` Skipped: ${report.skipped.map(item => `${CATEGORY_LABELS[item.category]} (${item.reason})`).join("; ")}.` : "";
      status.textContent = `Set up. ${report.credentialStored ? "Hub token saved to Keychain. " : "Enter the hub token below. "}${report.applied.length ? `Applied: ${report.applied.map(key => CATEGORY_LABELS[key]).join(", ")}.` : ""}${skipped}`;
      paste.value = ""; await deps.onApplied(outcome);
    } catch (error) { if (!disposed) status.textContent = describePairingError(error); }
    finally { if (!disposed) setBusy(false); }
  };
  go.addEventListener("click", () => { void run(paste.value); });
  paste.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void run(paste.value); } });
  scan.addEventListener("click", () => {
    if (busy || !deps.scanner) return;
    scanAbort?.abort(); scanAbort = new AbortController(); status.textContent = "Point the camera at the code on your computer."; setBusy(true);
    const cancel = el("button", undefined, "Stop scanning"); cancel.type = "button"; cancel.addEventListener("click", () => scanAbort?.abort());
    preview.replaceChildren(); preview.hidden = false; preview.append(cancel);
    void deps.scanner.scan(scanAbort.signal, video => { video.style.width = "100%"; video.style.maxWidth = "320px"; video.style.borderRadius = "8px"; preview.prepend(video); })
      .then(text => { preview.hidden = true; preview.replaceChildren(); setBusy(false); return run(text); })
      .catch(error => { if (disposed) return; preview.hidden = true; preview.replaceChildren(); setBusy(false); status.textContent = error instanceof ScannerError && error.reason === "aborted" ? "Scanning stopped." : describePairingError(error); });
  });
  return () => { disposed = true; scanAbort?.abort(); settle?.(false); };
}
