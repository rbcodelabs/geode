# Desktop Base background visibility captures

Actual synthetic Linux Electron captures from tested `cb41b6c9261d684a44be32e87eaf617e9ee20ab2`, 2026-10-15, 1280×815. The [capture manifest](capture-manifest.json) pins the original PNG and associated actual state JSON hashes. Copies are byte-identical; no redraw or image manipulation.

- [Reading after reveal](reading-returned.png): the original unfinished Base input still displays draft 9 after programmatic hide/reveal. State JSON independently proves provider priority 2, exact input/root/parent/source/camera and zero application writes. The screenshot alone does not prove provider state or focus retention; reveal does not automatically refocus.
- [Live Preview after reveal](live-preview-returned.png): the same bounded nested Base draft preservation in Live Preview. This does not establish persistent native ownership across arbitrary editor virtualization or source replacement.
- [Reading explicit cancel](reading-explicit-cancel.png): the user deliberately focused the preserved input and pressed Escape; the input is retired and provider priority 2 remains unchanged. The actual event ledger proves trusted Escape targeted INPUT, not the surrounding grid.

Only desktop Base through the audited programmatic tab path is covered. Compact/mobile visibility, sidebar/adaptive transitions, Canvas text/edge drafts and current-input double-click rebuild remain separate gaps. Inherited mobile regression verification is recorded separately and does not establish these desktop semantics on mobile.
