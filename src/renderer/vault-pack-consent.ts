/**
 * Consent-screen rows for vault pack plugins (ADR 0050). Kept out of app.ts and
 * written against an injected element factory so it can be unit-tested without
 * a DOM.
 */
import type { VaultPackPluginSummary } from "../shared/vault-pack-types";

/** The slice of an element this module touches. */
export interface ConsentNode<N> {
  title: string;
  append(...children: N[]): void;
}
export type ConsentElementFactory<N> = (tag: "li" | "span" | "code", className?: string, text?: string) => N;

export interface GithubPinDescription {
  /** True when the pack constrains the plugin to a version range. */
  pinned: boolean;
  /** Short label: "Pinned range ^1.4.0" or "Unpinned: latest release". */
  label: string;
  /** What it resolves to right now, and the release-age rule. May be empty. */
  detail: string;
  /** Present when the unpinned state deserves a warning. */
  warning?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeGithubPin(plugin: VaultPackPluginSummary): GithubPinDescription {
  const resolved = plugin.resolvedVersion
    ? `currently resolves to ${plugin.resolvedVersion}`
    : plugin.resolveError
      ? `cannot be resolved right now: ${plugin.resolveError}`
      : "";
  if (plugin.range) {
    const age = plugin.minReleaseAgeDays ?? 0;
    const ageText = age > 0 ? `skips releases newer than ${plural(age, "day")}` : "no release-age wait";
    return {
      pinned: true,
      label: `Pinned range ${plugin.range}`,
      detail: [resolved, ageText].filter(Boolean).join("; "),
    };
  }
  return {
    pinned: false,
    label: "Unpinned: latest release",
    detail: resolved ? `${resolved}; the version installed may differ` : "installs whatever the newest release is when the vault is created",
    warning: "This plugin is not pinned to a version range. Its code is whatever the repository publishes at install time.",
  };
}

/** One `<li>` for the plugin list. */
export function renderVaultPackPlugin<N extends ConsentNode<N>>(el: ConsentElementFactory<N>, plugin: VaultPackPluginSummary): N {
  const item = el("li", "vault-pack-plugin");
  item.append(el("span", "vault-pack-plugin-name", `${plugin.name ?? plugin.id}${plugin.version ? ` ${plugin.version}` : ""}`));
  item.append(el("span", "vault-pack-plugin-source", plugin.source === "github" ? `GitHub: ${plugin.repo}` : "Bundled in this pack"));
  if (plugin.source === "github") {
    const pin = describeGithubPin(plugin);
    item.append(el("span", pin.pinned ? "vault-pack-plugin-pin vault-pack-plugin-pinned" : "vault-pack-plugin-pin vault-pack-plugin-unpinned", pin.label));
    if (pin.detail) item.append(el("span", "vault-pack-plugin-pin-detail", pin.detail));
    if (pin.warning) item.append(el("span", "vault-pack-plugin-unpinned-warning", pin.warning));
  }
  if (plugin.sha256) {
    const hash = el("code", "vault-pack-plugin-hash", `sha256 ${plugin.sha256.slice(0, 16)}…`);
    hash.title = plugin.sha256;
    item.append(hash);
  }
  const state = plugin.blocked ? "Blocked by your administrator: installed disabled" : plugin.enabled ? "Enabled" : "Installed disabled";
  item.append(el("span", "vault-pack-plugin-state", state));
  if (plugin.firstParty) {
    item.append(
      el("span", "vault-pack-plugin-impersonation", `Warning: "${plugin.id}" is the id of a plugin that ships with Geode. Only continue if you expected this pack to replace it.`),
    );
  }
  return item;
}
