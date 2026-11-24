# Layout exemptions

Exemptions for the visual layout mode (`RF_VISUAL_MODE=layout node tests/visual/run.mjs`, see `tests/visual/layout.mjs`).

One file per task, named after the task: `<task>.json` (for example `s2-T10.json`). Each file holds an array of entries:

```json
[
  { "screen": "settings-preferences", "key": "#offline-diagnostics", "reason": "pushed down by the new app-theme radios" },
  { "screen": "login", "key": "*", "reason": "login restyled through the macros (Q5)" }
]
```

- `screen` is a key-screen name from `tests/visual/gallery-pages.mjs` (`KEY_SCREEN_PAGES`), without viewport or scheme. An entry covers every viewport and scheme of that screen.
- `key` is a box key as `collectBoxes()` records it: `#id` (digit runs in ids become `*`, and a repeated key gets `[2]`, `[3]`, … in document order), `.article-row[i]` or `.nav-item[i]`. A key ending in `*` matches as a prefix (`#install-app-*`). A key entry exempts that box in pass A (fonts blocked, strict).
- In pass B an exact key entry (no `*`) exempts that structural key only when it is extra in head (a new box replacing an old one, e.g. s3-T8's `#tab-bar`); a moved structural key requires the explicit boolean `structural: true` on an exact-key entry. Missing or absent structural anchors still fail. Existing entries without this flag retain their extra-only behavior. Sources uses the flag only for its intentionally resized main/table columns, with separate per-side viewport containment assertions.
- `key: "*"` exempts the whole screen in both passes. It is accepted only with that screen's gallery shots reviewed (`RF_VISUAL_MODE=gallery`).
- `reason` is required. The report (`test-results/visual-report/layout.md`) lists every loaded entry and names each exemption it applies with its file and reason.

Every `*.json` in this directory is merged; other files (this README) are ignored. A malformed entry fails the run.
