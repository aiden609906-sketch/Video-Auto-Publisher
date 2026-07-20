# Douyin publisher fixtures

These fixtures are sanitized, scoped HTML fragments captured from the real Douyin creator publish page on 2026-07-20. A local logged-in browser profile and local test media were used only to expose the relevant UI states. The capture stopped before the final publish action; no final publish button was clicked.

Captured states:

- `form-ready.html`
- `topic-picker-open.html`
- `cover-editor-open.html`
- `cover-uploading.html`
- `cover-applied.html`
- `declaration-modal-open.html`
- `declaration-selected.html`
- `ready-before-publish.html`

Each file contains only the selected publish form, popup, or dialog fragment. The sanitizer removes scripts, styles, media sources, links, account/profile elements, free-form content, URLs, file values, comments, and non-allowlisted attributes. Unknown text and dynamic `data-*` values are replaced with `[redacted]`.

The capture tool returns HTML without writing when imported. Its CLI accepts a path to a local JSON configuration file and writes UTF-8 only when that configuration contains an explicit `fixtureDir`. Keep capture configuration files outside version control because they may contain local profile paths. Use only one browser instance with a given profile, and never advance beyond the state immediately before publishing.
