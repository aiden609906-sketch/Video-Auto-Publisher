# Douyin publisher fixtures

These fixtures are sanitized, scoped HTML fragments captured from the real Douyin creator publish page on 2026-07-20. A local logged-in browser profile and local test media were used only to expose the relevant UI states. The capture stopped before the final publish action; no final publish button was clicked.

Captured states:

- `upload-entry-current.html`
- `video-post-upload-current.html`
- `form-ready.html`
- `topic-picker-open.html`
- `cover-editor-open.html`
- `cover-applied.html`
- `declaration-modal-open.html`
- `declaration-selected.html`
- `ready-before-publish.html`

Each file contains only the selected publish form, popup, or dialog fragment. The sanitizer removes scripts, styles, media sources, links, account/profile elements, free-form content, URLs, file values, comments, and non-allowlisted attributes. Unknown text and dynamic `data-*` values are replaced with `[redacted]`.

The real page did not expose a stable, distinguishable uploading DOM state. Uploading is therefore intentionally not represented by a fixture and must not be detected through loading/spinner classes, transient text, or permanently mounted wrappers. Publisher adapters perform a bounded wait after the upload action and treat only the observable `cover-applied` terminal state as success.

The capture tool returns HTML without writing when imported. Its CLI accepts a path to a local JSON configuration file and writes UTF-8 only when `fixtureDir` is exactly this repository's `tests/fixtures/publisher/douyin` directory. Aliases, symlinks, junctions, reparse-style path changes, parent traversal, and any directory outside that exact root are rejected. Keep capture configuration files outside version control because they may contain local profile paths.

CLI writes are create-only and fail closed when the target slug already exists. To recapture an existing fixture, first review the exact intended file, explicitly move or delete that one file outside the capture tool, and then run capture; the CLI never removes or overwrites an existing fixture automatically. Use only one browser instance with a given profile, and never advance beyond the state immediately before publishing.

`allowedUiText` may contain only entries from the capture tool's exported Douyin fixed UI vocabulary. Unknown entries are rejected before capture, and retained text attributes are subject to the same vocabulary or structural-value rules as text nodes.
