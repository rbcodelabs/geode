import { ExcludedFiles } from "../excluded-files";

export function renderFilesAndLinksTab(container: HTMLElement, exclusions: ExcludedFiles): void {
  const heading = document.createElement("h2"); heading.textContent = "Files and links";
  const label = document.createElement("label"); label.textContent = "Excluded files";
  const textarea = document.createElement("textarea"); textarea.rows = 7; textarea.className = "excluded-files-input"; textarea.setAttribute("aria-label", "Excluded files");
  const help = document.createElement("p"); help.className = "setting-item-description";
  help.textContent = "Hide potential-link targets in Outgoing links. One vault-relative file/folder or /pattern/i per line. Patterns support character classes and one * or +; groups, alternation and braces are unsupported. Saved for this vault on this device. Search, indexing and sync are unaffected.";
  const status = document.createElement("div"); status.setAttribute("role", "status");
  const save = document.createElement("button"); save.type = "button"; save.textContent = "Save exclusions"; save.disabled = true; textarea.disabled = true;
  label.appendChild(textarea); container.append(heading, label, help, save, status);
  void exclusions.ready.then(() => { textarea.value = exclusions.patterns.join("\n"); textarea.disabled = false; save.disabled = false; }).catch(() => { status.textContent = "Could not load excluded files settings."; });
  save.addEventListener("click", () => {
    save.disabled = true; status.textContent = "Saving…";
    void exclusions.save(textarea.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))
      .then(() => { status.textContent = "Exclusions saved."; })
      .catch(error => { status.textContent = error instanceof Error ? error.message : "Could not save exclusions."; })
      .finally(() => { save.disabled = false; });
  });
}
