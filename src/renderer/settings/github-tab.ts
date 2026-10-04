import type { GeodeApi } from "../../main/preload";

type GithubAuthApi = NonNullable<GeodeApi["githubAuth"]>;

type AppReport = Extract<Awaited<ReturnType<GithubAuthApi["appInfo"]>>, { ok: true }>["value"];

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

/** Settings "GitHub" card: device-flow sign-in, reachable repos, disconnect. Returns a disposer. */
export function renderGithubTab(container: HTMLElement, api: GithubAuthApi): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastKey = "";
  let report: AppReport | null = null;
  let reportError: { message: string; url?: string } | null = null;
  let reportLoading: Promise<void> | null = null;

  const loadReport = () => {
    reportLoading ??= api.appInfo().then((res) => {
      report = res.ok ? res.value : null;
      reportError = res.ok ? null : { message: res.message, url: res.url };
      reportLoading = null;
      lastKey = "";
    });
    return reportLoading;
  };

  const heading = document.createElement("h2");
  heading.textContent = "GitHub";
  const card = document.createElement("section");
  card.className = "setting-item github-connect-card";
  container.append(heading, card);

  const text = (tag: string, content: string, className?: string) => {
    const el = document.createElement(tag);
    el.textContent = content;
    if (className) el.className = className;
    return el;
  };
  const button = (label: string, onClick: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  };

  const render = async () => {
    const status = await api.status();
    if (disposed) return;
    // Skip DOM churn (and losing focus) while nothing changed during pending polls.
    const key = JSON.stringify([status, report, reportError]);
    if (key === lastKey) return;
    lastKey = key;
    card.replaceChildren();
    // The configured App changed (config edit, other vault): the old report no longer applies.
    if (report && (report.slug !== status.app.slug || report.clientId !== status.app.clientId)) report = null;
    if (!report && !reportError) void loadReport().then(() => void render());

    const warnings = permissionWarnings(report);
    const problem = report?.problem ?? null;
    const appBlock = () => {
      const nodes: HTMLElement[] = [];
      const label = appLabel(status.app, report);
      nodes.push(text("p", status.state === "connected" ? `Connected via ${label}` : `GitHub App: ${label}`, "setting-item-description"));
      if (problem) nodes.push(text("p", problem.message, "setting-item-description github-app-problem"));
      for (const w of warnings) nodes.push(text("p", `⚠ ${w}`, "setting-item-description github-app-warning"));
      if (problem || warnings.length) {
        const url = report?.settingsUrl;
        if (url) nodes.push(button("Open App settings", () => void api.openUrl(url)));
      }
      return nodes;
    };
    const extraPermissions = (report?.permissions?.extra.length ?? 0) > 0;

    if (status.state === "pending") {
      card.append(
        text("p", "Enter this code on GitHub to finish connecting:", "setting-item-description"),
        text("p", status.userCode, "github-user-code"),
        button("Open GitHub", () => void api.openUrl(status.verificationUri)),
        text("p", `Waiting for authorization at ${status.verificationUri}`, "setting-item-description"),
      );
      return;
    }
    if (status.state === "connected") {
      card.append(...appBlock(), text("p", status.login ? `Signed in as ${status.login}` : "Connected to GitHub"));
      const repos = document.createElement("div");
      repos.setAttribute("role", "status");
      repos.textContent = "Loading repositories…";
      card.append(
        repos,
        button("Disconnect", () => {
          void api.disconnect().then((res) => {
            card.append(
              text(
                "p",
                res.ok
                  ? "Local tokens deleted. To fully revoke access, remove Geode at github.com/settings/applications."
                  : res.message,
                "setting-item-description",
              ),
              button("Open GitHub application settings", () =>
                void api.openUrl(res.ok ? res.value.revokeUrl : "https://github.com/settings/applications")),
            );
            lastKey = "";
          });
        }),
      );
      void api.listAccess().then((res) => {
        if (disposed) return;
        if (!res.ok) {
          repos.textContent = res.message;
          return;
        }
        repos.replaceChildren();
        const names = res.value.flatMap((inst) => inst.repositories.map((r) => r.fullName));
        repos.append(
          text("p", names.length ? `Reachable repositories (${names.length}):` : "No repositories granted yet. Install the app on a repository from GitHub."),
        );
        const list = document.createElement("ul");
        for (const name of names) list.append(text("li", name));
        repos.append(list);
      });
      return;
    }
    card.append(...appBlock());
    if (status.state === "reauth_required" || status.state === "error") {
      card.append(text("p", status.message, "setting-item-description"));
    } else if (!status.encryptionAvailable) {
      card.append(text("p", "No OS keychain is available, so GitHub tokens cannot be stored safely. Connecting is disabled.", "setting-item-description"));
      return;
    } else {
      card.append(text("p", "Connect a GitHub account so Geode can give threads short-lived, repository-scoped tokens.", "setting-item-description"));
    }
    card.append(
      button(
        extraPermissions ? "Connect anyway" : status.state === "reauth_required" ? "Reconnect GitHub" : "Connect GitHub",
        () => {
          void api.start({ confirmExtraPermissions: extraPermissions }).then((res) => {
            lastKey = "";
            if (!res.ok) {
              card.append(text("p", res.message, "setting-item-description"));
              const url = res.url;
              if (url) card.append(button("Open App settings", () => void api.openUrl(url)));
            } else void render();
          });
        },
      ),
    );
  };

  void render();
  timer = setInterval(() => void render(), POLL_MS);
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
