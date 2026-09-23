# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-23

### Added

- Resize the message input with mouse, touch, or keyboard; it resets after a successful send.
- Shift+Tab in the message input cycles through enabled permission modes.
- A Working... indicator appears below responses during pauses in text output.

### Changed

- Idle messages start without relay prefixes; busy messages use Steer, Queue, or Interrupt.
- Profile selection moves into the composer; empty input shows Stop while the agent is working.
- Queued messages have inline withdrawal and recovery controls, replacing the separate queue panel.
- Warnings and errors appear in the conversation instead of a separate activity-notices section.
- Tool calls show arguments and results together; response rounds share a single Agent heading.
- New sessions stream thinking by default when available, with previews in collapsed entries.
- Context added by meka is hidden by default and can be enabled in Settings → Diagnostics.
- Permission modes use distinct icons, with a yellow warning for unrestricted access.

### Fixed

- Typing a message no longer scrolls to the bottom while reading earlier conversation content.
- Sent messages appear immediately, before the agent finishes responding.
- Unreachable connections time out after 10 seconds; connection attempts can also be canceled.

## [0.1.0] - 2026-09-18

### Added

- A static web interface for meka 0.59.0 and 0.60.0, with no separate application server.
- Saved connections with API tokens kept in local storage or session storage.
- Live conversations with reasoning, tool activity, and approvals that stay visible across pages.
- Steer, queue, interrupt, and cancel controls, with permission mode beside the message input.
- Image attachments, skill activation, and Markdown with tables, code, math, and Mermaid diagrams.
- Session creation, settings, forks, compaction, rewind, archive import, and transcript export.
- Memory and skill editors, plus one-time and recurring schedules with optional gates.
- MCP status, tool catalogs, and reconnect controls; profiles and instructions are read-only.
- Context usage, cache hit rate, background tasks, and session schedules in a pinned details panel.
- Saved text drafts and recovery controls for interrupted feeds and uncertain submissions.
- Light and dark themes, narrow layouts, and collapsible, resizable session panels.
- Hosting at the root or a subpath, with GitHub Pages deployment on version tags.

[Unreleased]: https://github.com/k4yt3x/mekaweb/compare/0.2.0...HEAD
[0.2.0]: https://github.com/k4yt3x/mekaweb/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/k4yt3x/mekaweb/releases/tag/0.1.0
