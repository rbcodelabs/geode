import type { GeodeApi } from "../../main/preload";

type GithubAuthApi = NonNullable<GeodeApi["githubAuth"]>;

const POLL_MS = 2000;

/** Settings "GitHub" card: device-flow sign-in, reachable repos, disconnect. Returns a disposer. */
export function renderGithubTab(container: HTMLElement, api: GithubAuthApi): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastKey = "";

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
    const key = JSON.stringify(status);
    if (key === lastKey) return;
    lastKey = key;
    card.replaceChildren();

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
      card.append(text("p", status.login ? `Signed in as ${status.login}` : "Connected to GitHub"));
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
    if (status.state === "reauth_required" || status.state === "error") {
      card.append(text("p", status.message, "setting-item-description"));
    } else if (!status.encryptionAvailable) {
      card.append(text("p", "No OS keychain is available, so GitHub tokens cannot be stored safely. Connecting is disabled.", "setting-item-description"));
      return;
    } else {
      card.append(text("p", "Connect a GitHub account so Geode can give threads short-lived, repository-scoped tokens.", "setting-item-description"));
    }
    card.append(
      button(status.state === "reauth_required" ? "Reconnect GitHub" : "Connect GitHub", () => {
        void api.start().then((res) => {
          lastKey = "";
          if (!res.ok) card.append(text("p", res.message, "setting-item-description"));
          else void render();
        });
      }),
    );
  };

  void render();
  timer = setInterval(() => void render(), POLL_MS);
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
