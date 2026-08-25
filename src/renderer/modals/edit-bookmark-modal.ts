import type { App } from "../app";
import { Modal } from "./modals";
import {
  bookmarkDefaultLabel,
  collectGroups,
  descendantGroupIds,
  findItemById,
  findParentGroupId,
  moveItem,
  renameBookmark,
  type Bookmark,
} from "../bookmarks";

const TOP_LEVEL_VALUE = "__root__";

/**
 * "Edit bookmark" dialog (spec docs/spec/02-core-plugins.md §Bookmarks: "Edit
 * bookmark dialog to modify existing bookmarks", "optional custom title and
 * group assignment"). Two fields — a custom title and a target group — modelled
 * on `ManageVaultsModal`'s hand-built multi-field layout (app.ts). Save routes
 * through the App's single `mutateBookmarks` persist path, applying
 * `renameBookmark` then `moveItem`.
 *
 * Works for a leaf bookmark or a group row; for a group the title field just
 * renames it and the group `<select>` re-parents it (its own id is excluded
 * from the options so it can't be nested inside itself).
 */
export class EditBookmarkModal extends Modal {
  private titleInput!: HTMLInputElement;
  private groupSelect!: HTMLSelectElement;

  constructor(app: App, private itemId: string) {
    super(app);
    this.modalEl.classList.add("mod-edit-bookmark");
  }

  onOpen(): void {
    const item = findItemById(this.app.bookmarksRoot, this.itemId);
    if (!item) {
      this.close();
      return;
    }
    this.contentEl.innerHTML = "";

    const heading = document.createElement("h2");
    heading.textContent = "Edit bookmark";
    this.contentEl.appendChild(heading);

    // --- Title field -------------------------------------------------------
    const titleField = document.createElement("div");
    titleField.className = "setting-item";
    const titleLabel = document.createElement("label");
    titleLabel.className = "setting-item-name";
    titleLabel.textContent = "Title";
    this.titleInput = document.createElement("input");
    this.titleInput.type = "text";
    this.titleInput.className = "prompt-input";
    const defaultLabel = item.type === "group" ? item.title : bookmarkDefaultLabel(item as Bookmark);
    this.titleInput.value = item.title ?? "";
    this.titleInput.placeholder = defaultLabel;
    titleField.append(titleLabel, this.titleInput);
    this.contentEl.appendChild(titleField);

    // --- Group field -------------------------------------------------------
    const groupField = document.createElement("div");
    groupField.className = "setting-item";
    const groupLabel = document.createElement("label");
    groupLabel.className = "setting-item-name";
    groupLabel.textContent = "Group";
    this.groupSelect = document.createElement("select");
    this.groupSelect.className = "dropdown";
    const topOption = document.createElement("option");
    topOption.value = TOP_LEVEL_VALUE;
    topOption.textContent = "(top level)";
    this.groupSelect.appendChild(topOption);
    // When editing a group, exclude the group itself AND its whole descendant
    // subtree: `moveItem` rejects re-parenting a group under its own descendant
    // (cycle), which would otherwise persist the title change while silently
    // dropping the move — a confusing partial result.
    const excluded = descendantGroupIds(this.app.bookmarksRoot, this.itemId);
    excluded.add(this.itemId);
    for (const group of collectGroups(this.app.bookmarksRoot)) {
      if (excluded.has(group.id)) continue;
      const opt = document.createElement("option");
      opt.value = group.id;
      opt.textContent = `${"  ".repeat(group.depth)}${group.title}`;
      this.groupSelect.appendChild(opt);
    }
    const currentParent = findParentGroupId(this.app.bookmarksRoot, this.itemId);
    this.groupSelect.value = currentParent ?? TOP_LEVEL_VALUE;
    groupField.append(groupLabel, this.groupSelect);
    this.contentEl.appendChild(groupField);

    // --- Buttons -----------------------------------------------------------
    const buttons = document.createElement("div");
    buttons.className = "modal-button-container";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const save = document.createElement("button");
    save.type = "button";
    save.className = "mod-cta";
    save.textContent = "Save";
    save.addEventListener("click", () => void this.save());
    buttons.append(cancel, save);
    this.contentEl.appendChild(buttons);

    this.titleInput.focus();
    this.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.save();
      }
    });
  }

  private async save(): Promise<void> {
    const title = this.titleInput.value.trim();
    const selected = this.groupSelect.value;
    const targetGroupId = selected === TOP_LEVEL_VALUE ? null : selected;
    const currentParent = findParentGroupId(this.app.bookmarksRoot, this.itemId);
    this.close();
    await this.app.mutateBookmarks((root) => {
      // Setting an empty title clears any custom override (falls back to the
      // default label); a non-empty one stores it.
      let next = renameBookmark(root, this.itemId, title);
      if (targetGroupId !== currentParent) {
        next = moveItem(next, this.itemId, targetGroupId, Number.MAX_SAFE_INTEGER);
      }
      return next;
    });
  }
}
