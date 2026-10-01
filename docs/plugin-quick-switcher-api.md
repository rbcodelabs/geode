# Quick switcher plugin API

Geode-specific (Obsidian has no equivalent). Plugins can add rows to the global quick switcher (Cmd/Ctrl+O) for the typed query.

```ts
const { Plugin } = require("geode");

class ExamplePlugin extends Plugin {
  onload() {
    // Feature-detect so the same plugin still runs on real Obsidian.
    if (typeof this.registerQuickSwitcherProvider === "function") {
      this.registerQuickSwitcherProvider({
        id: "example",
        getItems: (query) => [
          { title: `Ask about "${query}"`, subtitle: "Example", icon: "message-square", onChoose: () => {} },
        ],
      });
    }
  }
}
```

- `getItems(query)` is synchronous and is called on every keystroke, only for a non-empty query.
- Row order: ranked files/bookmarks, then plugin rows (max 20 total), then "New note" and "Search the web" (plus a pinned "Open <url>" for URL-shaped input).
- A throwing provider is ignored; the provider is removed automatically when the plugin unloads.
- Types `QuickSwitcherProvider` and `QuickSwitcherPluginItem` are exported from `geode`.

The quick switcher itself always offers "New note" and "Search the web" (via the Web Viewer search engine setting) for a non-empty query, matching the New Tab picker.
