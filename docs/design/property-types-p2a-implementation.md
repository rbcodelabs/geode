# Property types P2a implementation

Historical implementation checkpoint: original source references and verification status below are retained as provenance. Current P1/P2a package, regression fixes and remote gates are recorded in [the delivery record](properties-delivery.md); accepted scope is accessible in [the Properties design](properties-parity.md).

Accepted scope: Task c8d407d1-9e59-40ae-bb64-6b7862649752 → Solution
523dc576-9b4d-4028-a8d3-e2e5f765d45a → KR c3b390f0-92a8-479c-b629-2b6745d577d5.
This implements the registry/type-control portion of the accepted Properties P2
design at b0b44d2, using ADR0031 and the existing approved sidebar visual reference
`design-13b25764-6655-463d-bd18-a8902e3b0f18`. It stacks on P1 d6eae38.

One `PropertyTypes` owner belongs to App. It loads `host.config("types")` after
opening the vault and before plugins initialize. The compatibility adapter and
shared PropertyEditor controls refer to the same owner. Lightweight App doubles
receive a memory-only owner. Native compact selects reuse normal control styling;
date/datetime-local inputs keep calendar strings rather than Date objects.

Synchronous assignments update controls immediately. Ordered writes each apply
one assignment to the last acknowledged map. Failure reverts the current matching
version to acknowledged state without overwriting a newer optimistic assignment.
Closing a vault stops new assignments and drains pending writes before the host
changes vaults. Keys use Map/null-prototype records; authored names are display
values and lookups are lowercase. No bulk note edits occur on type assignment.

The generic host read contract conflates missing and malformed/unreadable JSON as
null; that limitation is explicit. Structured unsupported type-document shapes
refuse editing. Unknown future types and extra configuration fields are retained.
Source mutations continue through P1 guarded editor adapters, preserving undo,
stale/read-only checks, dirty text and unsupported source values.

Tests cover persistence/reload, independent vault owners, unknown and prototype
keys, ordered rollback/failure, compatibility agreement, local dates/leap dates,
seconds, null/unsupported values, shared control refresh and stale/read-only
mutations. Desktop regressions are authored separately; full gates and screenshot
capture remain coordinator-owned until their results are recorded.
