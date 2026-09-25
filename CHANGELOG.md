# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- In-app completion toasts and an optional chime, with separate browser notifications.

### Changed

- Use consistent switches for settings and checkbox styling for Markdown task lists.

## [0.4.1] - 2026-09-25

### Changed

- Replace Working... with aligned activity dots that animate unless reduced motion is enabled.

## [0.4.0] - 2026-09-25

### Added

- Set a conversation max width, including full width, in Settings → Appearance.
- Adjust conversation font size and width from the header, with direct entry and saved defaults.

### Changed

- Size table columns to their contents, keeping short values together and wrapping longer text.
- Open diagrams and images in a fitted viewer with zoom controls, dragging, and touch pinch/pan.
- Show submitted image previews immediately while the agent is working.
- Center the conversation and composer in the window as side panels change, when space allows.
- Keep mouse and touch interactions visually quiet while preserving keyboard focus indicators.

### Fixed

- Render bold and italic text correctly beside Chinese, Japanese, and Korean punctuation.

## [0.3.0] - 2026-09-24

### Added

- Rename sessions from their heading or list, and pin favorites, on meka 0.64.0 or newer.
- Search session titles and conversations, with matching excerpts in the session list.
- Adjust conversation font size in Settings → Appearance.
- Show primary arguments beside tool names in collapsed calls.

### Changed

- Update API support through meka 0.64.0, including inbox items without a source label.
- Start the composer at two lines while keeping it expandable for longer drafts.
- Show one connection-loss banner, with automatic recovery and a Retry button.

### Fixed

- Refresh session headings after the first message without reloading the page.

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

[Unreleased]: https://github.com/k4yt3x/mekaweb/compare/0.4.1...HEAD
[0.4.1]: https://github.com/k4yt3x/mekaweb/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/k4yt3x/mekaweb/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/k4yt3x/mekaweb/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/k4yt3x/mekaweb/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/k4yt3x/mekaweb/releases/tag/0.1.0
