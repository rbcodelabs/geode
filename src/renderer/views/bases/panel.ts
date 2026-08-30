/**
 * A floating content panel anchored under a toolbar button — used by the
 * Filter/Sort/Properties toolbar menus, which (unlike `App.showMenu`'s flat
 * `{title, action}` list) need rich interactive content (inputs, selects,
 * nested add/remove rows). Closes on outside click or Escape, mirroring
 * `App.showMenu`'s dismissal behavior.
 */
export interface Panel {
  el: HTMLElement;
  close(): void;
}

export function openPanel(anchorEl: HTMLElement, build: (panel: Panel) => void, extraClass = ""): Panel {
  document.querySelectorAll(".bases-panel").forEach((el) => el.remove());

  const el = document.createElement("div");
  el.className = `bases-panel${extraClass ? ` ${extraClass}` : ""}`;
  if (document.querySelector(".is-mobile")) el.classList.add("is-mobile-panel");
  const rect = anchorEl.getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom + 4}px`;

  const panel: Panel = {
    el,
    close() {
      document.removeEventListener("mousedown", onOutsideClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      el.remove();
    },
  };

  const onOutsideClick = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && e.target !== anchorEl && !anchorEl.contains(e.target as Node)) {
      panel.close();
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") panel.close();
  };

  build(panel);

  document.body.appendChild(el);
  document.addEventListener("mousedown", onOutsideClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  return panel;
}
