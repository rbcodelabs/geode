# Daily parity integration checkpoint

Task `477e3114-860c-4526-94bd-9c3298443e81`; branch
`test/overnight-daily-integration`. The exact overnight instruction authorizes
integration and verification through reviewed PRs, with no merge/release,
publication, dependencies, destructive data actions or external messages in this
task. Root independently reviews integration resolutions; the integration
engineer does not act as their own independent reviewer.

This task links Solutions `7e7d8e2a-e5e3-4a78-ba2c-1bb9a6ff708e` (editor),
`a3c803a7-3cdb-4e26-ae33-eb49c41985c4` (metadata),
`523dc576-9b4d-4028-a8d3-e2e5f765d45a` (Properties/outgoing),
`e0b922c6-e23d-49ae-9bfe-a53df1c76a96` (Footnotes) and
`1a6abff5-6d47-41d6-b9e0-b2108d3cdf9c` (Vault), through the daily-use behavior
parity KR `c3b390f0-92a8-479c-b629-2b6745d577d5`. Original feature branches,
worktrees and regression evidence are preserved.

## Source selection

Base `f662d51a03b071b7f3ed2be030296eb412e77b1e` already contains frozen Audit
`1ec6a77`, Metadata `218e8a8`, Outgoing `895be3d`, Properties P1 `39a1681` and
Properties P2a. `git cherry` against that base identifies only these additions:

| Reviewed source | Integration commit | Scope |
| --- | --- | --- |
| `bd322b423db8807855d57c008fa419d08249646b` | `818d384` | Folding, multiple selections, editor settings |
| `f00213dd92d4353618924e41a55da1775d094242` | `30b35bb` | Editor rollback and synthetic visual evidence |
| `3b2e055de4f9d7ce2debe2b1bedb6404f6ed47e2` | `abda098` | Footnotes core pane |
| `8edb1faec655f3d4ef96a36fc6d127dd63510f5f` | `51884dc` | Truncated definition refusal |
| `fd91fa6ee772223e2fc02eb4cbfbefc078d2b3f0` | `cf65c1b` | Synthetic Footnotes captures |
| `7806735dd6ab84765669ae480b71e48a5ecaaee1` | `e841be4` | Toggle persistence rejection reporting |
| `236f737f00c5d11fcc97ad3192ddcd3eafdca2c0` | `bf54d83` | Exact binary copy and traversal root |

Editor `def9d82/9a6d04f/b63cae9` and Vault `6f32587/6c97451/5e4f180` are
patch-equivalent common harness fixes already in the base, and were not applied
again. `git range-diff` shows the two feature commits with resolutions described
below; the remaining five patches compare equal. No Workspaces, PDF or new public
Editor API source is included.

## Resolutions for independent review

- Editor/App: combine both `files-and-links` and `editor` in the settings ID
  union/list and retain their separate render branches and navigation entries.
  Preserve Properties and Outgoing command registration alongside fold commands.
- Editor/MarkdownView: content changes schedule normal autosave and fire
  `editor-change`; folding changes retain their separate `layout-change` event.
  Do not replace either listener behavior with the other feature's version.
- Footnotes/App: retain all Properties/Outgoing imports plus FootnotesPlugin.
  Vault close awaits the existing property-type owner close and the Footnotes
  lifecycle/stop before closing the vault. No cleanup owner is removed.
- Footnotes/MarkdownView: its editor-change addition is already present after
  the editor resolution; retain that existing combined listener once.
- CSS: concatenate the distinct outgoing/property/type controls, folding gutter
  and Footnotes rules, without replacing or duplicating their blocks.

## Combined regression evidence

New unit tests use the actual MarkdownView source mutation/formatting methods,
CM state/history/folding, property transform and footnote projection. They check
property/link/footnote undo after preceding dirty body changes, retained fold
ranges, and forward/reversed multi-selection formatting after a property change.
Their small dispatch harness is not a real EditorView or autosave proof.

New real Electron tests exercise actual Properties, Outgoing and Footnotes panes
against one CRLF note, preserve a body edit confirmed absent from disk before
the property commit, and require exact isolated undo and final CRLF autosave.
A second flow checks both settings surfaces, folding and multiple-selection
formatting without losing the property update. These tests are authored and
listed successfully; actual Electron execution remains queued until root grants
the serialized slot. Original feature RED evidence is retained; no new integration
defect has yet been reproduced or fixed beyond the explicit conflict resolutions.

At this checkpoint, nine targeted unit files pass 59 tests, including two new
joint tests. Typecheck and build pass locally using locked Electron 42.10.0 and
Vitest 4.1.11. `pm-config.md` has no compute_offload entry. Logs are retained by
the coordinator. Full unit and Electron gates, independent resolution review and
shared screenshot publication remain pending. Local copied feature images do
not establish a combined UI capture or completed publication. No parity ledger
status, production release or PR-ready claim is made here.
