# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-01

First public release.

### Added

- Doubao (豆包) share import: `https://www.doubao.com/thread/<id>` links are accepted next to DeepSeek
  share links. A JSON snapshot is read first (regular ids via `POST /alice/message/share/get`, mobile `x…`
  ids via `POST /im/message/share/get`), with the share page's SSR `data-fn-args` payload as a fallback.
- Mobile `x…` Doubao shares: previously these only produced a "needs login" error because the rendered page
  lazy-loads its messages; the anonymous `im/message/share/get` snapshot now returns the full thread.
- `SHARE_LAZY` error code and message, used when a share page declares lazy loading and the snapshot is
  empty — the import fails instead of writing a truncated session.
- Placeholder line for Doubao messages that contain only media (`（这条消息在豆包网页端只有图片或视频，没有文字）`).
- Per-source dedup keys: `deepseek:<id>` / `doubao:<id>` in `$DSH_HOME/share-import/index.json`
  (old journal entries with a bare DeepSeek id are still honoured).
- Doubao shares whose first message is from the assistant fall back to the share title, so the session is
  not called "DeepSeek share import".
- Bilingual UI strings for both sources and the new error code.
- `lib/errors.js`: `ShareError` is now a standalone module shared by both readers (avoids a cycle between
  `share.js` and the readers).
- Offline smoke coverage for both Doubao payload shapes, snapshot routing, ordering and failure branches,
  plus real-fetch regression for both sources.

### Changed

- Link parsing now returns `{ source, id }` instead of a bare id; the accepted host set is explicit
  (`chat.deepseek.com`, `www.doubao.com`, `doubao.com`), everything else is rejected.
- Outbound reads go through one helper that validates the returned text: the deployment's web-fetch seam is
  preferred, but when it returns rendered Markdown instead of the raw document (a configured provider can do
  that) or fails, the plugin retries with the platform `fetch`.
- `conversationTitle(messages, fallback)` accepts a fallback title so an assistant-first share can use its
  own title.
- `README.md` is now English with a Chinese translation in `README.zh-CN.md`; MIT attribution cleaned up
  (`NOTICE.md` documents the ported files).

## [0.1.0] — 2026-10-31

Initial, never-published snapshot: DeepSeek share import only, sidebar entry, settings section, sidebar
visibility switch, duplicate guard, event invariants checked by `test/smoke.mjs`.
