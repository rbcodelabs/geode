import type { GeodeApi } from "../../main/preload";

type GithubAuthApi = NonNullable<GeodeApi["githubAuth"]>;

type AppReport = Extract<Awaited<ReturnType<GithubAuthApi["appInfo"]>>, { ok: true }>["value"];
type AuthStatus = Awaited<ReturnType<GithubAuthApi["status"]>>;
type ConnectedStatus = Extract<AuthStatus, { state: "connected" }>;

/** What listing the reachable repositories came back with; null until it has been asked. */
export type AccessState = { ok: true; names: string[] } | { ok: false; message: string } | null;

/** The agent-threads daemon keeps GitHub access for roughly this long after the last token refresh. */
const AGENT_GRACE_NOTE = "Agents in containers lose GitHub access ~15 min after the last refresh.";
const UNREACHABLE_PREFIX = /^Could not reach GitHub:\s*/;

const POLL_MS = 2000;

/** "Bankrate DeployHub (bankrate-prototypes)": the name when GitHub told us one, always the slug. */
function appLabel(app: { slug: string }, report: AppReport | null): string {
  return report?.name && report.name !== app.slug ? `${report.name} (${app.slug})` : app.slug;
}

/** What the App grants versus what Geode needs, as plain sentences. */
export function permissionWarnings(report: AppReport | null): string[] {
  const p = report?.permissions;
  if (!p) return [];
  const out: string[] = [];
  const missing = p.missing.map((m) => `${m.permission} (${m.needed}${m.have ? `, has ${m.have}` : ""})`);
  if (missing.length) {
    const prs = p.missing.some((m) => m.permission === "pull_requests");
    out.push(`Missing permissions: ${missing.join(", ")}.${prs ? " Opening pull requests will fail." : " Features that need them will fail."}`);
  }
  if (p.extra.length) {
    out.push(
      `Broader than Geode needs: ${p.extra.map((e) => `${e.permission} (${e.level})`).join(", ")}. Agent threads will hold these powers.`,
    );
  }
  return out;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

export interface ConnectionMessage {
  severity: "error" | "warn";
  text: string;
  /** Marks messages about the configured App, for callers/tests that look for them. */
  kind?: "app-problem" | "app-warning";
}

export interface ConnectionView {
  badge: "Connected" | "Problem";
  tone: "ok" | "bad";
  /** Every distinct message, once. */
  messages: ConnectionMessage[];
  /** "Last refreshed 3 min ago · access token valid until 7:40 PM". */
  tokenLine: string | null;
}

/**
 * Everything the connected tab says, derived once so each fact appears once:
 * a transport failure seen by several probes (App lookup, repo list, refresh)
 * collapses into a single "Can't reach GitHub" message.
 */
export function connectedView(
  status: ConnectedStatus,
  report: AppReport | null,
  reportError: { message: string } | null,
  access: AccessState,
  now: number,
): ConnectionView {
  const { health } = status;
  const messages: ConnectionMessage[] = [];
  const seen = new Set<string>();
  const add = (m: ConnectionMessage) => {
    if (seen.has(m.text)) return;
    seen.add(m.text);
    messages.push(m);
  };

  const unreachable: { reason: string; at: number | null }[] = [];
  const noteUnreachable = (message: string, at: number | null) => {
    unreachable.push({ reason: message.replace(UNREACHABLE_PREFIX, ""), at });
  };
  if (health.lastError) noteUnreachable(health.lastError.message, health.lastError.at);
  if (report?.problem?.code === "unavailable") noteUnreachable(report.problem.message, null);
  if (access && !access.ok && UNREACHABLE_PREFIX.test(access.message)) noteUnreachable(access.message, null);
  if (unreachable.length) {
    const { reason, at } = unreachable[0];
    add({ severity: "error", text: `Can't reach GitHub${at ? ` since ${formatClock(at)}` : ""}: ${reason}. ${AGENT_GRACE_NOTE}` });
  }

  if (report?.problem && report.problem.code !== "unavailable") {
    add({ severity: "error", text: report.problem.message, kind: "app-problem" });
  }
  if (reportError) add({ severity: "error", text: reportError.message });
  if (access && !access.ok && !UNREACHABLE_PREFIX.test(access.message)) add({ severity: "error", text: access.message });
  for (const w of permissionWarnings(report)) {
    add({ severity: w.startsWith("Missing") ? "error" : "warn", text: w, kind: "app-warning" });
  }

  const tokenParts: string[] = [];
  if (health.lastRefreshAt) tokenParts.push(`Last refreshed ${formatAgo(health.lastRefreshAt, now)}`);
  if (health.accessTokenExpiresAt) {
    tokenParts.push(
      health.accessTokenExpiresAt > now
        ? `access token valid until ${formatClock(health.accessTokenExpiresAt)}`
        : "access token due for refresh",
    );
  }
  const tokenLine = tokenParts.length ? tokenParts.join(" · ").replace(/^./, (c) => c.toUpperCase()) : null;

  const problem = messages.some((m) => m.severity === "error");
  return { badge: problem ? "Problem" : "Connected", tone: problem ? "bad" : "ok", messages, tokenLine };
}

type AppSettingsView = Awaited<ReturnType<GithubAuthApi["getSettings"]>>;

/** Shown wherever policy disables a control, so it is explained rather than missing. */
export const MANAGED_NOTE = "Managed by your administrator.";

const SOURCE_LABEL: Record<"policy" | "env" | "vault" | "global" | "default", string> = {
  policy: "administrator policy",
  env: "environment variable",
  vault: "open vault's .geode/app.json",
  global: "geode.json",
  default: "built-in default",
};

/** Where each effective value comes from, and which higher layers hide what the form edits. */
export function appSettingsNotes(view: AppSettingsView): string[] {
  const notes = [
    `Effective App: ${view.appSlug.value} (${SOURCE_LABEL[view.appSlug.source]}), client ID ${view.clientId.value} (${SOURCE_LABEL[view.clientId.source]}).`,
  ];
  const fields: ["clientId" | "appSlug", string][] = [["appSlug", "App slug"], ["clientId", "Client ID"]];
  for (const [key, label] of fields) {
    const by = view.overriddenBy[key];
    if (by === "policy") notes.push(`${label} is pinned by your administrator and overrides the value saved here. ${MANAGED_NOTE}`);
    else if (by) notes.push(`${label} is set by the ${SOURCE_LABEL[by]}, which overrides the value saved here. Remove it there for this setting to take effect.`);
  }
  if (view.allowSources.env) notes.push("Repository allowlist is set by environment variables and replaces the one saved here.");
  if (view.allowSources.policy) notes.push("Your administrator also restricts the repositories and owners agents may reach; this applies on top of the allowlist saved here and cannot be widened.");
  if (view.managed?.settingsLocked) notes.push(`These settings are locked. ${MANAGED_NOTE}`);
  return notes;
}

/** Settings "GitHub" card: device-flow sign-in, reachable repos, disconnect. Returns a disposer. */
export function renderGithubTab(container: HTMLElement, api: GithubAuthApi): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastKey = "";
  let report: AppReport | null = null;
  let reportError: { message: string; url?: string } | null = null;
  let reportLoading: Promise<void> | null = null;
  let access: AccessState = null;
  let accessLoading: Promise<void> | null = null;
  let checking = false;
  let notice: { text: string; url: string } | null = null;
  let startError: { message: string; url?: string } | null = null;

  const loadReport = (fresh = false) => {
    reportLoading ??= api.appInfo(fresh ? { fresh } : undefined).then((res) => {
      report = res.ok ? res.value : null;
      reportError = res.ok ? null : { message: res.message, url: res.url };
      reportLoading = null;
      lastKey = "";
    });
    return reportLoading;
  };
  const loadAccess = () => {
    accessLoading ??= api.listAccess().then((res) => {
      access = res.ok
        ? { ok: true, names: res.value.flatMap((inst) => inst.repositories.map((r) => r.fullName)) }
        : { ok: false, message: res.message };
      accessLoading = null;
      lastKey = "";
    });
    return accessLoading;
  };

  /** Re-ask GitHub about the App and the reachable repositories, bypassing the App cache. */
  const recheck = async () => {
    checking = true;
    lastKey = "";
    void render();
    await Promise.all([loadReport(true), loadAccess()]);
    checking = false;
    lastKey = "";
    if (!disposed) void render();
  };

  const heading = document.createElement("h2");
  heading.textContent = "GitHub";
  const card = document.createElement("section");
  card.className = "github-connect-card sync-status-card";
  container.append(heading, card);

  const text = (tag: string, content: string, className?: string) => {
    const el = document.createElement(tag);
    el.textContent = content;
    if (className) el.className = className;
    return el;
  };
  const button = (label: string, onClick: () => void, className?: string) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    if (className) el.className = className;
    el.addEventListener("click", onClick);
    return el;
  };
  const header = (tone: string, badge: string, sub: string | null) => {
    card.dataset.tone = tone;
    const head = document.createElement("div");
    head.className = "sync-status-head github-head";
    const textEl = document.createElement("div");
    textEl.className = "sync-status-text";
    textEl.append(text("div", badge, "sync-status-headline github-state-badge"));
    if (sub) textEl.append(text("div", sub, "sync-status-sub"));
    head.append(text("span", "", "sync-status-dot"), textEl);
    card.append(head);
  };
  const facts = (...rows: [string, string][]) => {
    const list = document.createElement("dl");
    list.className = "github-facts";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "github-fact";
      row.append(text("dt", label), text("dd", value));
      list.append(row);
    }
    return list;
  };
  const messageBlock = (messages: ConnectionMessage[]) => {
    const block = document.createElement("div");
    block.className = "github-status-block";
    block.setAttribute("role", "status");
    for (const m of messages) {
      const cls = ["github-status-line", `is-${m.severity}`, m.kind ? `github-${m.kind}` : ""].filter(Boolean).join(" ");
      block.append(text("p", m.text, cls));
    }
    return block;
  };

  const render = async () => {
    const status = await api.status();
    if (disposed) return;
    // Skip DOM churn (and losing focus) while nothing changed during pending polls.
    const now = Date.now();
    const key = JSON.stringify([status, report, reportError, access, checking, notice, startError, Math.floor(now / 60_000)]);
    if (key === lastKey) return;
    lastKey = key;
    card.replaceChildren();
    // The configured App changed (config edit, other vault): the old report no longer applies.
    if (report && (report.slug !== status.app.slug || report.clientId !== status.app.clientId)) report = null;
    if (!report && !reportError) void loadReport().then(() => void render());
    if (status.state !== "connected") access = null;
    else if (!access && !accessLoading) void loadAccess().then(() => void render());

    const appRow: [string, string] = ["App", appLabel(status.app, report)];
    const settingsUrl = report?.settingsUrl ?? startError?.url;
    const openSettings = () => (settingsUrl ? button("Open App settings", () => void api.openUrl(settingsUrl)) : null);
    const extraPermissions = (report?.permissions?.extra.length ?? 0) > 0;

    if (status.state === "pending") {
      header("busy", "Waiting for authorization", "Finish signing in on GitHub");
      card.append(
        text("p", "Enter this code on GitHub to finish connecting:", "setting-item-description"),
        text("p", status.userCode, "github-user-code"),
        button("Open GitHub", () => void api.openUrl(status.verificationUri)),
        text("p", `Waiting for authorization at ${status.verificationUri}`, "setting-item-description"),
      );
      return;
    }

    const managed = status.managed;
    applyLock(managed?.settingsLocked === true);

    if (status.state === "blocked_by_policy") {
      // The connection is kept, but unusable until policy is relaxed or the user signs in with an allowed account.
      header("bad", "Blocked by administrator policy", status.login ? `Signed in as ${status.login}` : null);
      card.append(facts(["Account", status.login ?? "Unknown"], appRow));
      card.append(messageBlock([{ severity: "error", text: status.message }]));
      const actions = document.createElement("div");
      actions.className = "sync-card-actions github-actions";
      if (managed?.connect === false) {
        card.append(text("p", `Signing in is disabled. ${MANAGED_NOTE}`, "setting-item-description github-managed-note"));
      } else {
        actions.append(
          button("Reconnect GitHub", () => {
            void api.start({ confirmExtraPermissions: extraPermissions }).then((res) => {
              startError = res.ok ? null : { message: res.message, url: res.url };
              lastKey = "";
              void render();
            });
          }, "mod-cta"),
        );
      }
      if (startError) card.append(messageBlock([{ severity: "error", text: startError.message }]));
      if (actions.childElementCount) card.append(actions);
      card.append(text("p", "Your connection has not been deleted. It works again if the policy is relaxed.", "setting-item-description"));
      return;
    }

    if (status.state === "connected") {
      const view = connectedView(status, report, reportError, access, now);
      header(view.tone, view.badge, view.tokenLine);
      card.append(facts(["Account", status.login ? `Signed in as ${status.login}` : "Connected to GitHub"], appRow));
      if (view.messages.length) card.append(messageBlock(view.messages));

      const actions = document.createElement("div");
      actions.className = "sync-card-actions github-actions";
      const problem = view.tone === "bad";
      const recheckButton = button(
        checking ? "Checking…" : problem ? "Retry" : "Check connection",
        () => void recheck(),
        problem ? "mod-cta" : "",
      );
      recheckButton.disabled = checking;
      actions.append(recheckButton);
      if (view.messages.length) {
        const open = openSettings();
        if (open) actions.append(open);
      }
      card.append(actions);

      if (!access || access.ok) {
        const repos = document.createElement("div");
        repos.className = "github-repos";
        if (!access) repos.append(text("p", "Loading repositories…", "setting-item-description"));
        else {
          repos.append(
            text(
              "p",
              access.names.length
                ? `Reachable repositories (${access.names.length}):`
                : "No repositories granted yet. Install the app on a repository from GitHub.",
              "github-repos-title",
            ),
          );
          if (access.names.length) {
            const list = document.createElement("ul");
            for (const name of access.names) list.append(text("li", name));
            repos.append(list);
          }
        }
        card.append(repos);
      }

      const footer = document.createElement("div");
      footer.className = "github-danger-zone";
      const disconnectManaged = managed?.disconnect === false;
      footer.append(
        text("span", disconnectManaged ? `Disconnecting is disabled. ${MANAGED_NOTE}` : "Removes Geode's local GitHub tokens.", `setting-item-description${disconnectManaged ? " github-managed-note" : ""}`),
        button(
          "Disconnect",
          () => {
            void api.disconnect().then((res) => {
              notice = {
                text: res.ok
                  ? "Local tokens deleted. To fully revoke access, remove Geode at github.com/settings/applications."
                  : res.message,
                url: res.ok ? res.value.revokeUrl : "https://github.com/settings/applications",
              };
              access = null;
              lastKey = "";
              void render();
            });
          },
          "mod-warning",
        ),
      );
      const disconnectButton = footer.querySelector("button");
      if (disconnectManaged && disconnectButton) disconnectButton.disabled = true;
      card.append(footer);
      return;
    }

    header("off", "Not connected", null);
    card.append(facts(appRow));
    const messages: ConnectionMessage[] = [];
    if (report?.problem) messages.push({ severity: "error", text: report.problem.message, kind: "app-problem" });
    for (const w of permissionWarnings(report)) messages.push({ severity: "warn", text: `⚠ ${w}`, kind: "app-warning" });
    if (status.state === "reauth_required" || status.state === "error") messages.push({ severity: "error", text: status.message });
    else if (!status.encryptionAvailable) {
      messages.push({ severity: "error", text: "No OS keychain is available, so GitHub tokens cannot be stored safely. Connecting is disabled." });
    }
    if (startError && !messages.some((m) => m.text === startError!.message)) messages.push({ severity: "error", text: startError.message });
    if (messages.length) card.append(messageBlock(messages));
    else card.append(text("p", "Connect a GitHub account so Geode can give threads short-lived, repository-scoped tokens.", "setting-item-description"));
    if (notice) {
      const url = notice.url;
      card.append(text("p", notice.text, "setting-item-description"), button("Open GitHub application settings", () => void api.openUrl(url)));
    }

    const actions = document.createElement("div");
    actions.className = "sync-card-actions github-actions";
    const keychainMissing = status.state === "disconnected" && !status.encryptionAvailable;
    if (managed?.connect === false) {
      card.append(text("p", `Signing in to GitHub is disabled. ${MANAGED_NOTE}`, "setting-item-description github-managed-note"));
    } else if (!keychainMissing) {
      actions.append(
        button(
          extraPermissions ? "Connect anyway" : status.state === "reauth_required" ? "Reconnect GitHub" : "Connect GitHub",
          () => {
            void api.start({ confirmExtraPermissions: extraPermissions }).then((res) => {
              notice = null;
              startError = res.ok ? null : { message: res.message, url: res.url };
              lastKey = "";
              void render();
            });
          },
          "mod-cta",
        ),
      );
    }
    const open = report?.problem || permissionWarnings(report).length || startError?.url ? openSettings() : null;
    if (open) actions.append(open);
    if (actions.childElementCount) card.append(actions);
  };

  // The App form is built once (not by the poll) so typing is never interrupted.
  const form = document.createElement("section");
  form.className = "github-app-card sync-status-card";
  container.append(form);
  const slugInput = document.createElement("input");
  slugInput.type = "text";
  slugInput.spellcheck = false;
  const clientInput = document.createElement("input");
  clientInput.type = "text";
  clientInput.spellcheck = false;
  const ownersInput = document.createElement("input");
  ownersInput.type = "text";
  ownersInput.spellcheck = false;
  ownersInput.placeholder = "Optional: comma-separated owners";
  const reposInput = document.createElement("input");
  reposInput.type = "text";
  reposInput.spellcheck = false;
  reposInput.placeholder = "Optional: comma-separated owner/name";
  const formMessages = document.createElement("div");
  formMessages.className = "github-status-block";
  formMessages.setAttribute("role", "status");
  formMessages.hidden = true;
  const saveButton = button("Save", () => void saveApp(), "mod-cta");
  const resetButton = button("Use default", () => void saveApp(true));
  const formActions = document.createElement("div");
  formActions.className = "sync-card-actions github-actions";
  const fieldErrors = new Map<string, HTMLElement>();
  const field = (key: string, label: string, input: HTMLInputElement) => {
    const row = document.createElement("label");
    row.className = "sync-field";
    const error = text("span", "", "github-status-line is-error github-field-error");
    error.hidden = true;
    fieldErrors.set(key, error);
    input.addEventListener("input", () => { error.hidden = true; input.removeAttribute("aria-invalid"); });
    row.append(text("span", label, "sync-field-label"), input, error);
    return row;
  };
  const inputs: Record<string, HTMLInputElement> = { appSlug: slugInput, clientId: clientInput, allowedOwners: ownersInput, allowedRepos: reposInput };
  const showFieldErrors = (errors: Record<string, string | undefined>) => {
    for (const [key, el] of fieldErrors) {
      const msg = errors[key];
      el.hidden = !msg;
      el.textContent = msg ?? "";
      if (msg) inputs[key].setAttribute("aria-invalid", "true");
      else inputs[key].removeAttribute("aria-invalid");
    }
  };
  const splitList = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const showFormMessages = (messages: ConnectionMessage[]) => {
    formMessages.replaceChildren();
    formMessages.hidden = messages.length === 0;
    for (const m of messages) formMessages.append(text("p", m.text, `github-status-line is-${m.severity}${m.kind ? ` github-${m.kind}` : ""}`));
  };
  const notesEl = document.createElement("div");
  notesEl.className = "github-app-notes";
  notesEl.style.display = "grid";
  notesEl.style.gap = "var(--size-4-2)";
  const fillNotes = (view: AppSettingsView) => {
    const [effective, ...overrides] = appSettingsNotes(view);
    notesEl.replaceChildren(text("p", effective, "setting-item-description"));
    if (overrides.length) notesEl.append(messageBlock(overrides.map((t) => ({ severity: "warn" as const, text: t, kind: "app-warning" as const }))));
  };
  // Locked by managed policy: shown read-only with a note rather than hidden. The main process
  // refuses `github-auth-set-settings` regardless; this only keeps the form honest.
  const lockNote = text("p", `These settings are locked. ${MANAGED_NOTE}`, "setting-item-description github-managed-note");
  lockNote.hidden = true;
  let formLocked = false;
  function applyLock(locked: boolean) {
    formLocked = locked;
    lockNote.hidden = !locked;
    for (const el of [slugInput, clientInput, ownersInput, reposInput, saveButton, resetButton]) el.disabled = locked;
  }
  const fillForm = (view: AppSettingsView) => {
    applyLock(view.managed?.settingsLocked === true);
    fillNotes(view);
    slugInput.value = view.global.appSlug ?? "";
    slugInput.placeholder = `Default: ${view.defaults.appSlug}`;
    clientInput.value = view.global.clientId ?? "";
    clientInput.placeholder = `Default: ${view.defaults.clientId}`;
    ownersInput.value = (view.global.allowedOwners ?? []).join(", ");
    reposInput.value = (view.global.allowedRepos ?? []).join(", ");
  };
  let formBusy = false;
  const saveApp = async (reset = false) => {
    if (formBusy || formLocked) return;
    formBusy = true;
    saveButton.disabled = resetButton.disabled = true;
    try {
      const res = await api.setSettings(
        reset
          ? { reset: true }
          : {
              appSlug: slugInput.value,
              clientId: clientInput.value,
              allowedOwners: splitList(ownersInput.value),
              allowedRepos: splitList(reposInput.value),
            },
      );
      if (disposed) return;
      if (!res.ok && res.blockedByPolicy) {
        applyLock(true);
        showFormMessages([{ severity: "error", text: res.message ?? `Not saved. ${MANAGED_NOTE}` }]);
        return;
      }
      if (!res.ok) {
        showFieldErrors(res.errors);
        showFormMessages([{ severity: "error", text: "Not saved. Fix the highlighted fields." }]);
        return;
      }
      showFieldErrors({});
      fillForm(res.settings);
      const messages: ConnectionMessage[] = [{ severity: "warn", text: "Saved. If this is a different GitHub App, the current GitHub sign-in is dropped and you will need to reconnect." }];
      // Verify straight away so a typo shows up here rather than at the next sign-in.
      const check = await api.appInfo({ fresh: true });
      if (disposed) return;
      if (!check.ok) messages.push({ severity: "error", text: check.message });
      else if (check.value.problem && check.value.problem.code !== "unavailable") {
        messages.push({ severity: "error", text: `${check.value.problem.code}: ${check.value.problem.message}`, kind: "app-problem" });
      } else if (check.value.problem) messages.push({ severity: "warn", text: `Could not verify the App: ${check.value.problem.message}` });
      else messages.push({ severity: "warn", text: `Verified: ${check.value.name ?? check.value.slug}.` });
      showFormMessages(messages);
      report = null;
      reportError = null;
      lastKey = "";
      void render();
    } finally {
      formBusy = false;
      saveButton.disabled = resetButton.disabled = formLocked;
    }
  };
  void api.getSettings().then((view) => {
    if (disposed) return;
    fillForm(view);
    form.replaceChildren(
      text("h3", "GitHub App"),
      text("p", "Use your own GitHub App (for example a company's private App) instead of the built-in one. Saved to geode.json. Switching Apps disconnects the current GitHub sign-in; you will be asked to reconnect.", "setting-item-description"),
      field("appSlug", "App slug", slugInput),
      field("clientId", "Client ID", clientInput),
      field("allowedOwners", "Allowed owners", ownersInput),
      field("allowedRepos", "Allowed repositories", reposInput),
      notesEl,
      lockNote,
      formMessages,
      formActions,
    );
    formActions.append(saveButton, resetButton);
  });

  void render();
  timer = setInterval(() => void render(), POLL_MS);
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
