# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.24.1] - 2026-10-22

### Fixed

- Appearance stays with each browser, since screens differ; it no longer follows the account.

## [0.24.0] - 2026-10-21

### Added

- mekaweb is a server installed beside meka: it serves the interface and passes requests to meka.
- Sign in with a password or a passkey; risky changes ask you to confirm it's you again.
- Settings lists the devices signed in, signs them out, and shows recent sign-in activity.
- Signing a device out ends its open connections; a new password signs out every other device.
- Files opens in a panel beside a session at its folder, browses anywhere, and mentions files.
- Uploads go in pieces and resume after a dropped connection; folders download as zip archives.
- A session's terminal docks under it, starts a shell when opened, and stays a bar while it runs.
- Ctrl+` shows or hides the session's terminal.
- Settings sets the terminal's font size; Ctrl with the wheel, =, - or 0 changes it for a while.
- Push notifications say when a turn finishes or fails, or waits for approval, with the app closed.
- Settings shows whether meka answers and whether this mekaweb supports its version.
- mekaweb keeps your preferences, so every device you sign in on shares them.
- Data saver sends less over mobile data: fewer messages, pictures on tap, and batched replies.
- File tool calls open the file in the session's Files; Files starts a session in a folder.
- The new-session folder picker makes the folder it names.

### Changed

- **Breaking:** mekaweb requires meka 0.83.0 or newer.
- **Breaking:** meka stays on loopback; browsers reach it only through mekaweb, holding no token.
- After a turn, only the messages that came after those shown are read again.
- The session list follows meka's change feed, and polls only every five minutes.
- Event streams arrive compressed, and an edit's change carries its changed lines, not whole files.
- An image over meka's 3.75 MB limit is shrunk to fit before sending, and says so.
- Push notifications replace the browser notifications an open page sent.

### Removed

- **Breaking:** web.meka.run, and connecting to meka straight from a browser: install mekaweb.
- **Breaking:** Saved connections, token storage, and settings import and export.

## [0.23.1] - 2026-10-21

### Deprecated

- web.meka.run is deprecated and will be removed soon; a closable banner links to this repo.

## [0.23.0] - 2026-10-21

### Added

- The memory editor sets how a memory loads, its expiry, source, and references, and verifies it.
- Memory cards mark inline, search-only, and expired memories; a memory links what references it.
- `memory_edit` and `skill_edit` calls show the memory or skill they edit.

### Changed

- Recognize meka 0.83.0 as a verified server version.

### Fixed

- An edit to a file over 1 MB shows its result while the turn runs, not a too-large note.

## [0.22.0] - 2026-10-20

### Changed

- Recognize meka 0.82.0 as a verified server version.
- Settings links to meka's online HTTP API reference, since meka 0.82.0 removed its Swagger UI.

### Fixed

- Errors and warnings below the conversation clear once the next turn starts, not only on reload.

## [0.21.0] - 2026-10-18

### Changed

- Session search stays hidden until opened from the search button beside New session, or Ctrl+K.

## [0.20.0] - 2026-10-18

### Added

- A turn keeps running after its tab closes; in new sessions, its approval prompts wait for you.
- Another client's message, a scheduled fire, or a report shows as soon as the turn it opens starts.
- A turn whose send went unconfirmed can be retried under the same key, as queued messages can.
- A queued message whose turn failed shows when meka will try it again, and why.
- A queued message meka gives up on is reported with the reason, and notifies when it was yours.
- The MCP page shows the protocol version each connected server speaks.
- meka's session tools show an icon, and `session_search` shows what it searched for.

### Changed

- mekaweb requires meka 0.78.0 or newer, which lets a turn run on without the request that sent it.
- Recognize meka 0.80.0 as a verified server version.
- A turn meka stopped because nobody was following it says so.

## [0.19.1] - 2026-10-18

### Fixed

- The message input's resize handle sits inside its top edge, clear of the checklist above it.
- The Latest button no longer lingers after folding a block leaves nothing below to scroll to.

## [0.19.0] - 2026-10-16

### Added

- The MCP tool list marks the tools meka defers until the agent loads them, or hides from it.

### Changed

- Recognize meka 0.77.0 as a verified server version; meka 0.76.0 and newer still connect.

### Fixed

- On meka 0.77.0, a call that loads tools completes and shows their names, not stuck running.

## [0.18.2] - 2026-10-16

### Fixed

- Switching connections no longer stops a running turn; mekaweb follows it until it ends.

## [0.18.1] - 2026-10-16

### Fixed

- Switching to a connection on another server leaves the open session instead of showing not found.

## [0.18.0] - 2026-10-16

### Added

- Arrows in Settings reorder connections, and the connection menu follows that order.
- Suspend hides a connection that is down without forgetting its token; Resume brings it back.
- Export connections and preferences to a file, then import it in another browser.

### Changed

- The connection switcher moved to the bottom of the navigation, styled like its other entries.
- Editing a connection keeps its saved token when the field is left blank; a rename won't reconnect.

### Fixed

- Editing a connection no longer moves it to the end of the list.

## [0.17.0] - 2026-10-15

### Added

- Scheduled fires and background task reports show as notes from meka, expanding to what was sent.
- A background task that finishes during a turn shows its report in that turn as it arrives.

### Changed

- mekaweb requires meka 0.76.0 or newer, which renames the session working directory field.
- Inbox messages show their sender's words without meka's header, named by any source they give.

## [0.16.0] - 2026-10-14

### Changed

- Recognize meka 0.75.0 as a verified server version; meka 0.71.0 and newer still connect.

### Fixed

- Loading earlier messages no longer repeats some after meka's turn retention deletes old turns.

## [0.15.2] - 2026-10-14

### Fixed

- Ctrl+scrolling the diagram and image viewer zooms one step per wheel notch, not nearly 3×.

## [0.15.1] - 2026-10-07

### Changed

- Sub-agents stay hidden until their parent's arrow shows them, the open session's included.

## [0.15.0] - 2026-10-07

### Added

- The open session's sub-agents are listed beneath it, without listing every session's sub-agents.
- An arrow at the start of each session's row shows or hides its sub-agents, loading them on demand.
- A running sub-agent's page shows its work live, and again whenever a follow-up runs it.
- Spawn and follow-up calls link to their sub-agent, listing the calls it makes while it runs.
- Copy, edit, or delete your messages, and copy, run again, or branch from the agent's turns.
- Approval prompts from a sub-agent name it and link to its session.
- When meka sends the agent back to its checklist, the turn shows a note with what meka wrote.
- The agent's open checklist shows above the message input while items remain open.

### Changed

- Session list statuses have their own shapes, such as a spinner for running and a check for done.
- mekaweb requires meka 0.71.0 or newer, and says so when connecting to an older server.
- Settings shows whether each profile accepts images, rather than only the default profile.
- The session list updates as soon as sessions change, rather than at the next 15-second refresh.
- Statuses include approvals and outcomes of turns run elsewhere, such as other tabs or schedules.
- Running sub-agents show as running in the session list.
- An open session's title and settings follow changes made in other tabs or clients.
- A conversation rewound in another tab or client updates without reloading.
- An approval prompt closes in every tab once it is answered elsewhere, expires, or is canceled.
- Tool calls are labeled with meka 0.70.0's checklist tools, which replace the todo tools.
- A running turn's notices show where they arrived; warnings and errors also stay below it.
- Search also finds sub-agent sessions, marked as sub-agents in the results.

### Removed

- The button that listed every session's sub-agents; each session's arrow lists its own instead.

### Fixed

- A notice from a running turn no longer marks the live preview incomplete or reloads the history.

## [0.14.3] - 2026-10-05

### Fixed

- In Firefox, typing or pasting in the message input scrolls it to keep the cursor in view.
- Starting a conversation opens its session without a blank frame or a brief loading notice.

## [0.14.2] - 2026-10-03

### Fixed

- The composer's profile and permission names no longer cut off the bottoms of letters like g and y.

## [0.14.1] - 2026-10-02

### Changed

- Sending a message returns the conversation to the latest output.

### Fixed

- Scrolling up while the agent works stops following its output, without having to scroll hard.

## [0.14.0] - 2026-09-30

### Added

- Attach images by pasting them into the message input or dropping them on the conversation.

## [0.13.1] - 2026-09-29

### Fixed

- Code blocks no longer flicker to plain text on each update while the agent writes them.

## [0.13.0] - 2026-09-29

### Changed

- Recognize meka 0.67.0 and 0.68.0 as supported server versions.
- On meka 0.68.0, a running compaction shows as compacting and does not notify when it finishes.

### Fixed

- Read-only tokens open sessions meka 0.68.0 hasn't loaded, following them once the server does.

## [0.12.1] - 2026-09-29

### Changed

- The delete session dialog focuses Delete, so Enter confirms it.

## [0.12.0] - 2026-09-28

### Changed

- Tool calls show an icon for their tool or tool group instead of the same ⌘ symbol.

## [0.11.1] - 2026-09-28

### Fixed

- Typing certain messages on the new conversation screen no longer crashes the page.

## [0.11.0] - 2026-09-27

### Changed

- The completion sound is a lower, softer two-note kalimba phrase with a light stereo echo.

### Fixed

- A long conversation no longer makes the whole page scrollable while the agent is working.

## [0.10.0] - 2026-09-27

### Added

- Toggle line wrapping for each code block and diagram source; wrapping is off by default.

### Changed

- Code blocks highlight every language Shiki bundles, such as Solidity and Kotlin.

## [0.9.0] - 2026-09-27

### Added

- Offset the conversation horizontally, such as for vertical tabs, within the conversation area.
- Center the conversation on the page or on the conversation area.
- Show a center line while dragging the offset slider and briefly after changing the position.
- Restore the default conversation font size, width, and position from Settings → Appearance.

### Changed

- The conversation font size also applies to the message input.
- Reading options are available on the new conversation screen.
- Destructive buttons, such as Remove, Forget token, and Disconnect, turn red on hover or focus.

## [0.8.0] - 2026-09-27

### Added

- Mark sessions with activity since you last viewed them as unread in the session list.
- Colour session dots for running, awaiting approval, and unread finished or failed turns.

### Changed

- Recognize meka 0.66.0 as a supported server version.
- The message input grows with its text until resized by hand, which holds until the next send.
- Running shell output gives way to the tool result when the command finishes, without repeating it.

### Fixed

- Show a note for tool results too large to stream instead of reconnecting the session feed.

## [0.7.1] - 2026-09-26

### Changed

- Recognize meka 0.65.0 as a supported server version.

## [0.7.0] - 2026-09-26

### Added

- Keyboard shortcuts for sessions, stopping turns, and search, with a keymap in navigation.
- Start conversations from a setup screen; sessions are created when the first message is sent.
- Choose a new conversation's working directory from recently used directories.

### Removed

- The permission prompts switch for new sessions; approval mode decides whether tool calls ask.
- The reasoning switch for new sessions; reasoning is always shown when the provider supplies it.

## [0.6.0] - 2026-09-26

### Added

- Install mekaweb with the meka logo and a standalone Home Screen window on iPhone and iPad.

### Fixed

- Show messages sent from another client while the agent's response is streaming.
- Keep mobile controls clear of screen cutouts and the keyboard, and avoid input focus zoom.
- Keep the mobile layout when using a phone in landscape orientation.
- Render Mermaid title frontmatter and formatted labels, and fix Gantt layout and contrast.

## [0.5.0] - 2026-09-25

### Added

- In-app completion toasts and an optional chime, with separate browser notifications.

### Changed

- Use consistent switches for settings and checkbox styling for Markdown task lists.
- Group sub-agent sessions beneath their parents with indentation and tree guide lines.
- Recognize meka 0.64.1 as a supported server version.

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

[Unreleased]: https://github.com/k4yt3x/mekaweb/compare/0.24.1...HEAD
[0.24.1]: https://github.com/k4yt3x/mekaweb/compare/0.24.0...0.24.1
[0.24.0]: https://github.com/k4yt3x/mekaweb/compare/0.23.1...0.24.0
[0.23.1]: https://github.com/k4yt3x/mekaweb/compare/0.23.0...0.23.1
[0.23.0]: https://github.com/k4yt3x/mekaweb/compare/0.22.0...0.23.0
[0.22.0]: https://github.com/k4yt3x/mekaweb/compare/0.21.0...0.22.0
[0.21.0]: https://github.com/k4yt3x/mekaweb/compare/0.20.0...0.21.0
[0.20.0]: https://github.com/k4yt3x/mekaweb/compare/0.19.1...0.20.0
[0.19.1]: https://github.com/k4yt3x/mekaweb/compare/0.19.0...0.19.1
[0.19.0]: https://github.com/k4yt3x/mekaweb/compare/0.18.2...0.19.0
[0.18.2]: https://github.com/k4yt3x/mekaweb/compare/0.18.1...0.18.2
[0.18.1]: https://github.com/k4yt3x/mekaweb/compare/0.18.0...0.18.1
[0.18.0]: https://github.com/k4yt3x/mekaweb/compare/0.17.0...0.18.0
[0.17.0]: https://github.com/k4yt3x/mekaweb/compare/0.16.0...0.17.0
[0.16.0]: https://github.com/k4yt3x/mekaweb/compare/0.15.2...0.16.0
[0.15.2]: https://github.com/k4yt3x/mekaweb/compare/0.15.1...0.15.2
[0.15.1]: https://github.com/k4yt3x/mekaweb/compare/0.15.0...0.15.1
[0.15.0]: https://github.com/k4yt3x/mekaweb/compare/0.14.3...0.15.0
[0.14.3]: https://github.com/k4yt3x/mekaweb/compare/0.14.2...0.14.3
[0.14.2]: https://github.com/k4yt3x/mekaweb/compare/0.14.1...0.14.2
[0.14.1]: https://github.com/k4yt3x/mekaweb/compare/0.14.0...0.14.1
[0.14.0]: https://github.com/k4yt3x/mekaweb/compare/0.13.1...0.14.0
[0.13.1]: https://github.com/k4yt3x/mekaweb/compare/0.13.0...0.13.1
[0.13.0]: https://github.com/k4yt3x/mekaweb/compare/0.12.1...0.13.0
[0.12.1]: https://github.com/k4yt3x/mekaweb/compare/0.12.0...0.12.1
[0.12.0]: https://github.com/k4yt3x/mekaweb/compare/0.11.1...0.12.0
[0.11.1]: https://github.com/k4yt3x/mekaweb/compare/0.11.0...0.11.1
[0.11.0]: https://github.com/k4yt3x/mekaweb/compare/0.10.0...0.11.0
[0.10.0]: https://github.com/k4yt3x/mekaweb/compare/0.9.0...0.10.0
[0.9.0]: https://github.com/k4yt3x/mekaweb/compare/0.8.0...0.9.0
[0.8.0]: https://github.com/k4yt3x/mekaweb/compare/0.7.1...0.8.0
[0.7.1]: https://github.com/k4yt3x/mekaweb/compare/0.7.0...0.7.1
[0.7.0]: https://github.com/k4yt3x/mekaweb/compare/0.6.0...0.7.0
[0.6.0]: https://github.com/k4yt3x/mekaweb/compare/0.5.0...0.6.0
[0.5.0]: https://github.com/k4yt3x/mekaweb/compare/0.4.1...0.5.0
[0.4.1]: https://github.com/k4yt3x/mekaweb/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/k4yt3x/mekaweb/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/k4yt3x/mekaweb/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/k4yt3x/mekaweb/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/k4yt3x/mekaweb/releases/tag/0.1.0
