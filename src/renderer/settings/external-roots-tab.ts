import type { ExternalRootsHost } from "../../shared/external-roots";

/** Core grant management stays available when Threads is disabled. No filesystem polling. */
export function renderExternalRootsTab(container: HTMLElement, host: ExternalRootsHost): () => void {
  let disposed = false;
  let generation = 0;
  let busy = false;
  const heading = document.createElement("h2"); heading.textContent = "Project folders";
  const intro = document.createElement("p");
  intro.textContent = "Manage Geode's local read-only folder grants. Removing a grant or association never deletes files or changes a Threads working directory.";
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh folder grants";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const list = document.createElement("div"); list.className = "external-root-grants";
  container.append(heading, intro, refresh, status, list);
  const run = async (operation: () => Promise<boolean>) => {
    if (busy || disposed) return;
    busy = true; status.textContent = "Waiting for confirmation…";
    try {
      const removed = await operation();
      if (!disposed) status.textContent = removed ? "Removed from Geode. External files are unchanged." : "Cancelled. Nothing was removed.";
    } catch {
      if (!disposed) status.textContent = "The grant changed or could not be removed. Refresh and try again.";
    } finally { busy = false; if (!disposed) await render(); }
  };
  const button = (label: string, accessibleLabel: string, operation: () => Promise<boolean>) => {
    const element = document.createElement("button"); element.type = "button"; element.textContent = label;
    element.setAttribute("aria-label", accessibleLabel);
    element.addEventListener("click", () => { void run(operation); });
    return element;
  };
  const render = async () => {
    const current = ++generation;
    try {
      const grants = await host.listGrants!();
      if (disposed || generation !== current) return;
      list.replaceChildren();
      if (!grants.length) {
        const empty = document.createElement("p"); empty.textContent = "No folder grants to manage."; list.append(empty);
      }
      for (const grant of grants) {
        const row = document.createElement("section"); row.className = "setting-item external-root-grant";
        row.setAttribute("aria-label", `${grant.root.label} ${grant.root.rootId.slice(0, 8)}`);
        const info = document.createElement("div"); info.className = "setting-item-info";
        const title = document.createElement("h3"); title.textContent = `${grant.root.label} · ${grant.root.rootId.slice(0, 8)}`;
        const detail = document.createElement("p"); detail.className = "setting-item-description";
        detail.textContent = `Read-only · ${grant.root.availability}${grant.sharedBindingCount ? ` · ${grant.sharedBindingCount} association${grant.sharedBindingCount === 1 ? " in another vault" : "s in other vaults"}` : ""}`;
        info.append(title, detail);
        for (const association of grant.associations) {
          const item = document.createElement("div");
          const label = document.createElement("p"); label.textContent = `${association.label} · ${association.active ? "Active — detach from Projects" : "Inactive association"}`;
          item.append(label);
          if (!association.active) item.append(button("Remove association…", `Remove association for ${association.label}`, () => host.removeStaleAssociation!(association.projectId)));
          info.append(item);
        }
        row.append(info);
        if (grant.removable) row.append(button("Remove folder grant…", `Remove folder grant ${grant.root.rootId.slice(0, 8)}`, () => host.removeOrphanGrant!(grant.root.rootId)));
        list.append(row);
      }
    } catch {
      if (!disposed && generation === current) { list.replaceChildren(); status.textContent = "Folder grants are unavailable. Refresh to try again."; }
    }
  };
  refresh.addEventListener("click", () => { void render(); });
  const unsubscribe = host.onChange?.(() => { void render(); });
  void render();
  return () => { disposed = true; generation++; unsubscribe?.(); };
}
