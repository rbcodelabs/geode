# File properties

Run **Show file properties** from the command palette to open the active note's properties in the right sidebar. The pane follows the centre note and shares its current buffer, including unsaved text. Live Preview uses the same controls. Reading mode can edit properties through this pane and refreshes its rendered note after a successful edit.

Edit a name or value and press Enter or leave the field to save. Escape restores the field. Add property opens a name/value row with an explicit Save property button. Remove buttons delete individual properties or list entries. Lists use separate fields, preserving commas and primitive value types. Number fields accept finite numeric literals; invalid text remains editable with an error. Each property mutation creates one undo step, separate from preceding body edits.

Duplicate names, malformed or duplicate YAML keys, non-mapping YAML roots, unclosed frontmatter and BOM-prefixed frontmatter refuse edits and offer source editing. Nested values remain read-only with an Edit source action. A stale field cannot overwrite a value changed elsewhere. Mutations preserve unrelated properties, YAML comments and the note body; CRLF frontmatter stays CRLF. Editing requires an owned note buffer; other file contexts show read-only values and an Open note action.

This is partial Properties parity. All-properties inventory/global rename, display preferences, autocomplete and the full documented keyboard commands remain future work. Reading's in-note property rendering remains separate and read-only. Existing Live Preview frontmatter decoration scan limits remain unchanged.

## Shared property types

The compact type picker beside each property name selects **text**, **list**,
**number**, **checkbox**, **date**, or **datetime**. The assignment applies to the
same case-insensitive property name throughout this vault. It updates the note
and sidebar controls without rewriting other notes. Authored property names stay
unchanged. `tags` has its reserved tags type; `aliases` and `cssclasses` remain
lists. Scalar list/tag values appear as one item, so commas are preserved.

Date controls keep local calendar values; datetime controls keep local authored
time and seconds. They do not convert between time zones. Unchanged controls do
not normalize the original string. An incompatible value or unknown imported
type remains visible with an Edit source action, without automatic conversion.
Nested values remain source-only. Null checkboxes appear unset; **Unset** clears
an existing scalar to YAML null. Normal edits keep the live buffer, dirty body
and undo behavior described above.

Assignments persist through the vault's `types` configuration. Plugins using
`metadataTypeManager.getAllProperties/getPropertyInfo/setType` share this owner;
`setType` still updates synchronously and persists asynchronously. Failed writes
show a notice and restore the last acknowledged assignment unless a newer change
is pending. Unknown imported type names and extra configuration fields survive
later saves. Failed reads and unsupported document shapes refuse type changes.
The host returns null for both absent and unreadable JSON, so this feature cannot
distinguish those cases; it does not claim corruption recovery.

Document presentation settings, full property keyboard workflows, All properties
inventory/search and global rename remain separate parity work.
