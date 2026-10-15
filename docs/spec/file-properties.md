# File properties: first implementation

Run **Show file properties** from the command palette to open the active note's properties in the right sidebar. The pane follows the centre note and shares its current buffer, including unsaved text. Live Preview uses the same controls. Reading mode can edit properties through this pane and refreshes its rendered note after a successful edit.

Edit a name or value and press Enter or leave the field to save. Escape restores the field. Add property opens a name/value row with an explicit Save property button. Remove buttons delete individual properties or list entries. Lists use separate fields, preserving commas and primitive value types. Number fields accept finite numeric literals; invalid text remains editable with an error. Each property mutation creates one undo step, separate from preceding body edits.

Duplicate names, malformed or duplicate YAML keys, non-mapping YAML roots, unclosed frontmatter and BOM-prefixed frontmatter refuse edits and offer source editing. Nested values remain read-only with an Edit source action. A stale field cannot overwrite a value changed elsewhere. Mutations preserve unrelated properties, YAML comments and the note body; CRLF frontmatter stays CRLF. Editing requires an owned note buffer; other file contexts show read-only values and an Open note action.

This is partial Properties parity. Vault-wide types, date/datetime controls, all-properties inventory/global rename, display preferences, autocomplete and the full documented keyboard commands remain future work. Reading's in-note property rendering remains separate and read-only. Existing Live Preview frontmatter decoration scan limits remain unchanged.
