# Using mekaweb

This guide covers connecting to meka and the interface's behavior in detail. See the [README](../README.md) for setup.

## Connecting

Enter your API token and the appropriate **Meka base URL** in the web UI:

| Where meka runs                      | Example base URL           |
| ------------------------------------ | -------------------------- |
| On the same computer as your browser | `http://127.0.0.1:8080`    |
| On another computer on your LAN      | `http://192.168.1.10:8080` |
| Behind your HTTPS reverse proxy      | `https://meka.example.com` |

Replace example hostnames and IP addresses with your own. `0.0.0.0` is a listen address, not a URL to enter in the browser. Use `127.0.0.1:8080` as the bind address when access is limited to the same computer or a reverse proxy on that computer.

Local connections from an HTTPS site depend on browser permissions. Chrome can request [Local Network Access](https://developer.chrome.com/blog/local-network-access); allow it for the UI if you want to connect locally. Browsers without the relevant HTTP exceptions may require an HTTPS endpoint or a locally hosted UI. For internet access, use an HTTPS reverse proxy with a browser-trusted certificate; meka itself serves HTTP.

If you open a project Pages URL such as `https://k4yt3x.github.io/mekaweb/`, use its origin instead:

```toml
[serve]
cors_allowed_origins = ["https://k4yt3x.github.io"]
```

The repository path `/mekaweb/` is not part of the origin. If you use both frontend addresses, list both origins.

For remote access, use HTTPS for both the web interface and the meka endpoint. On another device, `localhost` refers to that device, so use a reachable server address instead.

The interface has been checked in Chromium and Firefox, including narrow layouts. Safari and physical mobile devices have not been fully validated. Offline/PWA operation is not currently supported.

## Features

Start a conversation by describing a task and sending it. The folder button below the composer sets the working directory: enter an absolute path on the meka server, or choose one of your recent directories. Profile and permission mode sit beside Send; approval mode and delivery options are under **Settings**. A session is created only when you send; **New session** returns to this screen and keeps unsent drafts. If the first message fails after creation, retry in that session.

- **Messages:** Enter sends; Shift+Enter adds a newline. The composer starts at two lines and grows with longer drafts, up to three quarters of the conversation's height. Drag its top grip, or focus it and use arrow keys, to set a height yourself; it then stays fixed until the next send. Its height resets after a successful send. When idle, a message starts a direct streaming turn. While the agent works, messages use Steer by default; choose Queue or Interrupt in the composer's Settings. When a turn is running and the input is empty, Send becomes a red Stop button for that turn.
- **Images:** Attach images with the image button, by pasting them into the message input, or by dropping them anywhere on the conversation. A paste that also holds text, as from a spreadsheet, pastes the text. Images can be up to 3.75 MB each, in PNG, JPEG, GIF, WebP, BMP, or another raster format meka converts, such as TIFF. Other files, including SVG, HEIC, and PDF, are refused.
- **Conversation appearance:** Set **Conversation font size** and **Conversation max width** under **Settings → Appearance**. Both are saved in your browser. Width applies to the chat and composer, with a full-width option; font size applies to messages, their contents, and the text you type. Other pages and control text retain their sizes.
- **Conversation position:** The conversation is centered on the page by default, so opening or closing panels does not move it. Set **Center conversation on** to **Conversation area** to center it between the panels instead. **Conversation offset** moves it by a number of pixels, negative to the left. For vertical browser tabs or a tab sidebar, about half the sidebar's width re-centers it on the window. The conversation always stays within the conversation area at its full width.
- **Reading options:** Open **Aa** in the session or new conversation header to enter a font size or max width in pixels, then press **Enter** to apply. The **− / +** buttons and arrow keys apply 1 px font or 100 px width steps immediately. Leave width blank for full width; width also applies to the composer. Under **Position**, choose **Page** or **Area** to center on, and set **Offset** to move the conversation: enter pixels or use **− / +** for 10 px steps, or drag the slider below it. The slider's ends put the conversation against either side of the conversation area, and its notch marks no offset. A dashed line marks the conversation's center while you drag, and briefly after you change the offset or center. In **Settings → Appearance**, **Restore defaults** resets font size, width, and position. Adjustments are temporary unless you choose **Save**, which saves all four as defaults for this browser. **Reset**, changing sessions, or reloading restores your saved appearance settings.
- **Permissions:** Change permission mode directly beside Send, or press Shift+Tab in the message input to cycle through enabled modes. Select the profile beside permissions while the session is idle. Settings contains approval mode, working directory, skills, and delivery options. Images and skills can be sent while the session is idle.
- **Approvals:** Pending tool approvals remain visible when you move to another screen. A prompt from a sub-agent names it and links to its session. A prompt answered in another tab, expired, or canceled with its turn closes everywhere.
- **Workspace:** Collapse the navigation or session list to focus on a conversation. The details panel stays open until closed. Drag a panel divider to resize it, or use arrow keys when the divider has keyboard focus. Double-click resets its width.
- **Keyboard shortcuts:** Open **Keyboard shortcuts** at the bottom of navigation, or press **Ctrl+/** (**Cmd+/** on macOS), to see shortcuts for new, delete, rename, previous/next session, stopping a turn, and session search. Keyboard deletion always asks for confirmation; previous/next leaves text-field navigation unchanged.
- **Session titles:** Click the conversation heading to rename it. Enter, the checkmark, or clicking away saves; Escape or the cancel button discards the edit. Clearing the title restores the first-message label.
- **Sessions:** Search conversations from the session list, sub-agents' included. Each session's status icon shows its state with a shape as well as a colour: a green spinner while running, an amber triangle while a tool call waits for approval, and a small grey dot once read. A session with activity since you last viewed it gets a bold title and a blue check if its last turn finished, a red cross if it failed, or a dot when the outcome is unknown, such as for a canceled turn. Opening it clears the mark. Statuses come from the server and update as they change, whichever tab, client, or schedule ran the turn; a session another process runs, such as meka's terminal interface, updates at the next refresh. Read state is kept in this browser, so other browsers track their own. Sub-agents show when they are running but are not marked unread, since their results reach the parent. The open session's sub-agents are listed beneath it, and an open sub-agent's siblings beneath its parent. The arrow at the edge of a session's row lists its sub-agents or hides them. It shows when you point at or focus the row, or while sub-agents are listed beneath it, and always on touch screens. A running sub-agent's page shows its work as it happens. In the conversation, an `agent_spawn` or `agent_followup` call links to its sub-agent and, while the sub-agent runs, lists the calls it makes. Hover over a session or focus its row to reveal Rename, Pin, and Delete. These buttons stay visible in narrow and touch layouts, beside the title when space permits. Pins stay at the top of the list and are saved on the server. Use **Use first message** in Rename to reset a title. The session menu also offers fork, compact, rewind, export, and delete. Import accepts a meka JSON archive. Session-row deletion asks for confirmation; **Shift-click deletes immediately**, including sub-agent sessions.
- **Checklist:** While the agent has items open on its checklist, a strip above the message input shows how many and the one it is working on. Open it for the whole list, with each deferred item's reason. meka keeps a turn going until the pending and in-progress items are done, canceled, or deferred.
- **Notices:** What the agent or a provider reports during a turn appears in that turn, where it happened, until the turn is saved. Warnings and errors also stay below the conversation until you reload.
- **History:** The conversation shows meka's current model context. Compaction and rewind can replace it. Export the full transcript when you need earlier history. When meka sends the agent back to work, such as to items left open on its checklist, the turn shows a note; expand it to read what meka wrote.
- **Message actions:** Hover over or focus a message to copy, edit, or delete it, or an agent turn to copy its reply, run it again, or branch from it into a new session. The latest message and turn always show theirs, as does every message on a touch screen. Editing sends the edited message in place of the original, and running a turn again sends its message again; both replace everything after it, as deleting does. When later turns would be lost, mekaweb asks first; Shift-click skips the question. Files the agent changed stay changed. Branching copies the conversation up to that turn and leaves this one as it is. A change is refused when the conversation has changed since it was shown, such as by another tab; check it and try again. A message's images are sent again with it.

New sessions stream thinking when the provider supplies it. Injected context is hidden by default; enable **Show context added by meka** under **Settings → Diagnostics** to inspect it.

Withdraw and delivery-recovery controls appear inside their messages. If a submission has an uncertain outcome, inspect saved state before sending again. Use **Retry same submission** when offered for an inbox message; streaming direct turns cannot be safely retried automatically.

The interface supports Markdown tables, math, diagrams, authenticated image attachments, and code blocks with highlighting for Shiki's bundled languages, copying, and optional line wrapping. Collapsed tool calls show their primary argument when available; expand a call to inspect its full arguments and result. See [API support](api-coverage.md) for available operations and backend limitations.

Completion alerts are configured under **Settings → Notifications**, with a **Test** button for each option:

- **Browser notifications** are optional and appear when mekaweb is in the background. They require HTTPS (or localhost), browser permission, and a supported browser.
- **In-app notifications** are enabled by default. When a different conversation finishes or fails, a toast shows its title and opens it when clicked. Toasts dismiss after six seconds, pausing while hovered or keyboard-focused.
- **Completion sound** is optional and plays a short chime while mekaweb is in the foreground, including when you’re viewing the completed conversation. Background browser notifications use the operating system’s sound settings instead. Audio may require a click or key press after reloading the app.

In-app alerts work independently of browser notification permission and service workers. Keep mekaweb open and connected: closed or suspended pages cannot receive completion events.

## iPhone and iPad

In Safari, use **Share → Add to Home Screen**. Leave **Open as Web App** enabled if shown. Mekaweb opens with the meka icon and its own app window. It still needs a network connection to load and reach meka.

Connect to your meka instance inside the installed app. Its browser storage is separate from Safari, so saved connections and tokens do not carry over. If an older installation still shows a letter icon after updating, remove it and add it again; you may need to enter your connection details again.

On iOS, browser notifications require opening the Home Screen app. They are not a reliable background completion alert: iOS can suspend the app and its live connection when you switch away or lock the screen. Delivery while suspended would require server-side Web Push, which mekaweb does not use. See [WebKit’s Home Screen documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) and [storage behavior](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).

## Connections and local data

New connections default to **Local storage (persistent)**, which uses `localStorage` to keep the API token across browser restarts. Choose **Session storage (this tab)** in the **Token storage** selector to use `sessionStorage` for the current tab's session instead. Existing connections retain their saved choice. Use persistent storage only on a trusted browser profile and hosting origin.

Connection settings, appearance, layout, and text drafts are saved in browser storage. File attachments are kept in memory and are lost on reload. Clearing browser data removes local settings and drafts, but does not delete server sessions.

If the active endpoint becomes unreachable, one banner appears above the workspace. Mekaweb checks for recovery automatically; **Retry** checks immediately. Recovery preserves your open view and drafts and does not repeat submissions. Warnings about uncertain actions remain with those actions.

Forgetting or replacing a token disconnects open tabs that used it. Forgetting a token does not revoke it on the server. Removing a connection, or replacing its endpoint URL, also removes that connection's local drafts. Provider credentials remain on the meka server. Disconnecting does not necessarily stop accepted work; use Stop first if you want to cancel the current turn.

Token scopes determine which controls are available. Tokens access the server's shared session namespace; they do not create separate user accounts. A token without `sessions:w` cannot load a session into the server, so a session the server hasn't loaded shows its saved conversation. Live updates start once the server loads it, such as when a client with write access opens it.
