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
      footer.append(
        text("span", "Removes Geode's local GitHub tokens.", "setting-item-description"),
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
    if (!keychainMissing) {
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

  void render();
  timer = setInterval(() => void render(), POLL_MS);
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
