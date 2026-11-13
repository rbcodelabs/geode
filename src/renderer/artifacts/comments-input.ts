import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_REQUEST_ID_PATTERN,
  type AdoptCommentsInput,
  type AnchorReport,
  type ArtifactAnchorState,
  type RemoveCommentInput,
  type SavePinnedCommentInput,
  type SendCommentsInput,
  type UpdateCommentInput,
} from "../../artifacts/feedback-contract-v2";
import type { ArtifactFeedbackTarget } from "../../artifacts/feedback-contract";
import { rebuildHealedAnchor } from "./comments-rebuild";
import { freezePlain } from "./freeze-plain";

/**
 * Geode-side validation of what the embedder sends a comments provider (design note 1.3: "Geode checks what it can
 * before calling"). A failure is returned to the caller as a rejected "invalid" result and the provider is never
 * called. A success returns a fresh, frozen copy built from an allowlist, so a caller that keeps mutating its object
 * cannot change what the provider sees.
 */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const ANCHOR_STATES: ReadonlySet<string> = new Set<ArtifactAnchorState>(["exact", "moved", "approximate", "detached", "other-route", "unknown"]);
const ACTIONS: ReadonlySet<string> = new Set(["resolve", "dismiss", "reopen", "unqueue"]);

const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
const good = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value: freezePlain(value) });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && ARTIFACT_COMMENT_ID_PATTERN.test(value);

export function checkId(id: unknown): Checked<string> {
  return isId(id) ? good(id) : bad("That is not a comment id.");
}

function checkIds(ids: unknown, what: string): Checked<string[]> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ARTIFACT_COMMENTS_CAPS.maxBatch) {
    return bad(`${what} needs between 1 and ${ARTIFACT_COMMENTS_CAPS.maxBatch} comments.`);
  }
  const copy: string[] = [];
  for (const id of ids) {
    if (!isId(id)) return bad("That is not a comment id.");
    copy.push(id);
  }
  if (new Set(copy).size !== copy.length) return bad(`${what} lists the same comment twice.`);
  return good(copy);
}

export function checkUpdate(input: unknown): Checked<UpdateCommentInput> {
  if (!isObject(input) || !isId(input.id)) return bad("That is not a comment id.");
  const expectedVersion = input.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return bad("The comment version is not valid.");
  const change = input.change;
  if (!isObject(change)) return bad("The change is not valid.");
  if (typeof change.action === "string") {
    if (!ACTIONS.has(change.action)) return bad("That action is not supported.");
    return good({ id: input.id, expectedVersion, change: { action: change.action as "resolve" | "dismiss" | "reopen" | "unqueue" } });
  }
  const text = change.text;
  if (typeof text !== "string" || text.length < 1 || text.length > ARTIFACT_COMMENTS_CAPS.maxTextUnits) {
    return bad(`Comment text must be 1 to ${ARTIFACT_COMMENTS_CAPS.maxTextUnits} characters.`);
  }
  return good({ id: input.id, expectedVersion, change: { text } });
}

export function checkRemove(input: unknown): Checked<RemoveCommentInput> {
  if (!isObject(input) || !isId(input.id)) return bad("That is not a comment id.");
  const expectedVersion = input.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return bad("The comment version is not valid.");
  return good({ id: input.id, expectedVersion });
}

export function checkAdopt(input: unknown): Checked<AdoptCommentsInput> {
  if (!isObject(input)) return bad("The request is not valid.");
  const ids = checkIds(input.ids, "Adopting");
  return ids.ok ? good({ ids: ids.value }) : ids;
}

export function checkSend(input: unknown): Checked<SendCommentsInput> {
  if (!isObject(input)) return bad("The request is not valid.");
  const requestId = input.requestId;
  if (typeof requestId !== "string" || !ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test(requestId)) return bad("The request id is not valid.");
  const ids = checkIds(input.ids, "Sending");
  if (!ids.ok) return ids;
  if (typeof input.resend !== "boolean") return bad("The request is not valid.");
  const states = input.anchorStates;
  if (!isObject(states) || Object.getPrototypeOf(states) !== Object.prototype && Object.getPrototypeOf(states) !== null) return bad("The anchor states are not valid.");
  const anchorStates: Record<string, ArtifactAnchorState> = {};
  const keys = Object.keys(states);
  if (keys.length > ARTIFACT_COMMENTS_CAPS.maxComments) return bad("The anchor states are not valid.");
  for (const key of keys) {
    const state = states[key];
    if (!isId(key) || typeof state !== "string" || !ANCHOR_STATES.has(state)) return bad("The anchor states are not valid.");
    anchorStates[key] = state as ArtifactAnchorState;
  }
  return good({ requestId, ids: ids.value, resend: input.resend, anchorStates });
}

export function checkReports(reports: unknown): Checked<AnchorReport[]> {
  if (!Array.isArray(reports) || reports.length > ARTIFACT_COMMENTS_CAPS.maxReportAnchors) return bad("The anchor reports are not valid.");
  const out: AnchorReport[] = [];
  for (const report of reports) {
    if (!isObject(report) || !isId(report.id) || typeof report.state !== "string" || !ANCHOR_STATES.has(report.state)) return bad("The anchor reports are not valid.");
    const state = report.state as ArtifactAnchorState;
    if (report.healed === undefined) { out.push({ id: report.id, state }); continue; }
    const healed = rebuildHealedAnchor(report.healed);
    if (healed === null) return bad("The anchor reports are not valid.");
    out.push({ id: report.id, state, healed });
  }
  return good(out);
}

/**
 * The request is built by Geode (validated bridge, controller), so only its coherence with the routed target is
 * checked here: the selection must belong to the target artifact, and on a vault:read artifact there must be no
 * screenshot and the selection must be redacted (the same invariants the plugin enforces). The provider re-validates
 * everything else. A request that cannot be frozen (cyclic, absurdly deep) is refused instead of throwing.
 */
export function checkSave(input: unknown, target: ArtifactFeedbackTarget): Checked<SavePinnedCommentInput> {
  if (!isObject(input) || !isObject(input.request)) return bad("There is nothing to save.");
  const request = input.request;
  const selection = request.selection;
  if (!isObject(selection) || typeof selection.selectionId !== "string" || !/^sel_[0-9a-f]{32}$/.test(selection.selectionId)) return bad("There is nothing to save.");
  if (selection.artifactId !== target.artifactId) return bad("This selection belongs to a different artifact.");
  if (target.vaultRead && (request.screenshot !== null && request.screenshot !== undefined || selection.redacted !== true)) {
    return bad("This artifact can read the vault, so a pin cannot include a screenshot or page text.");
  }
  try {
    return { ok: true, value: freezePlain({ request } as unknown as SavePinnedCommentInput) };
  } catch {
    return bad("That request is too deeply nested to send.");
  }
}
