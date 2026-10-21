# API schema maintenance

`meka-0.83.0.json` was captured from meka `0.83.0`, commit `5c02b582961d2f39a9cbfe0a8605037d6370d7c9`, through `/v1/openapi.json` with `[serve].docs = true`. The generated REST types are committed in `src/api/schema.d.ts`; runtime connections do not require schema access.

mekaweb requires meka 0.78.0 or newer and refuses older servers during connection discovery. Compared with 0.68.0, the 0.70.0 and 0.71.0 APIs change these shapes the client used:

- `/v1/info` no longer reports `vision`; each `/v1/profiles` entry does.
- `/v1/sessions/{id}/context` no longer reports `used_percent`. The client divides `used` by `window`, rounding down as meka did.
- `GET /v1/sessions/{id}/schedule` is gone; `GET /v1/schedule?session=<id>` lists one session's jobs.
- A message's `turn_id` is the id of the turn that added it, shared by its tool results; the positional label moved to `turn_label`. Message actions count the turns a rewind drops by `turn_label`, the rule meka's rewind counts by.
- `subagent.activity` is gone from the session feed. A running sub-agent has a read-only feed of its own.
- The `todo_*` tools are `checklist_add`, `checklist_edit`, and `checklist_read`. meka renames them in stored history, so the client labels only the new names.
- A hole in a feed is a `feed.gap` event, no longer a `notice`, and a reader that falls behind is caught up rather than told to re-attach. A notice is only what the agent or a provider said.
- A turn's `images` take `{hash}` for an image the session's history holds, so a message is sent again without uploading its images. `ImageInput` therefore types every field as optional; the client keeps its own types for an attached image and a stored one.
- A message meka writes to send the model back to work opens with a `nudge` block. It stays in the agent's turn, is not counted as a turn, and arrives live as `turn.nudged`.

0.72.0 through 0.75.0 change no shape the client uses; the schema differs from 0.71.0's only in its descriptions. A title meka derives from the first message keeps 200 characters rather than 80. `[session].turn_retention` deletes the turns a compaction summarized once they age past its window, without an event and without moving `revision`, which counts the rewrite rows and so can even fall when an old compaction's row goes. Every later message moves up, so a page of earlier history is read with one message more and must end with the first one shown; otherwise the conversation is read again.

0.76.0 changes these:

- A session's `cwd` is `working_directory`: on the record, in create, fork, and `PATCH` bodies, and as the listing's filter. Every request type denies unknown fields, so an older server refuses the new name and a newer one the old; the client therefore requires 0.76.0.
- A user message keeps the kind of what meka wrote into it on another's behalf. An `inbox` block carries an item's `body`, the sender's words, with its `class` and the `source` it named; a `scheduled` block a job's fire, with `job_id` and `prompt`; and a `background_report` finished background work, with `task_ids`. On each, `text` is what the model read, header included. meka types the rows and archives older versions wrote as `text` blocks, and moves a report out of the `turn_context` block it used to end, so the client reads no headers. A message counts as someone's input by its `text`, `inbox`, or `image` blocks, and its author is the inbox `source` when every word came from that one. A scheduled fire is meka's message, but its `prompt` is the job's words, so it is copied, edited, deleted, and run again as a message is, as it was while it was a `text` block.
- A background task that finishes while a turn runs reaches it at the next tool-round boundary, as a `background_report` block behind that round's results, announced live as `task.reported` with `task_ids` and `text`. Like a nudge, it stays in the agent's turn. A turn that a scheduled fire or a report alone opens has no words from anyone, so it is shown as meka's.
- An `agent_spawn` or `agent_followup` result opens `Agent: <id>`, then the sub-agent's permission and directories, where it opened `agent: <id>` and a blank line. The client reads the id from either, since saved results keep the old form.
- The export archive is format 11, naming a session's `working_directory` and `additional_workspace_directories` where it named `cwd` and `additional_roots`.

0.77.0 changes no request, so 0.76.0 remains the minimum. It adds these:

- A tool result may carry a `tool_reference` item, `{type, tool_name}`, in history and in `tool_call.completed`: a deferred tool that `tool_load` or `tool_search` made callable on a profile whose `deferred_tools` is `native`, the default on the official Anthropic and OpenAI endpoints and both subscriptions. Such a result is references alone, since the endpoint refuses text beside one. The client shows each as the tool it loaded.
- Each `GET /v1/mcp/{name}/tools` entry states `loading`: `eager`, `deferred`, or `hidden`, by `deferral` and the server's `eager_load_tools`. A hidden tool is not registered, so the agent never sees it.
- The export archive is format 12, whose thinking blocks may carry a Chat Completions endpoint's reasoning. meka reads a format 11 archive as it is.

0.78.0 changes these, and the client therefore requires it:

- `POST /turn` takes `detach`. A detached request is only the trigger: meka answers `202` at admission with the turn record, and the turn runs whether or not its client stays. A request without it holds its turn, now also with `stream: false`, which meka stops at a round boundary once the request has been gone for `[serve] stream_reattach_grace` with nobody else listening; such a turn ends `canceled` with `reason: "abandoned"`. The client sends every idle turn detached, under its submission's `Idempotency-Key`, which a detached request commits at admission, so a send whose admission is unknown is retried safely on request, while meka still holds the key: it keeps a turn's in memory for a day. A turn known to have started is therefore never sent again.
- `GET /v1/sessions/{id}/turns/{turn_id}` reads one turn's record. The client settles a sent turn by it when the feed did not deliver its terminal.
- The session capability `answers_prompts_on_return` keeps a prompt in a turn no request holds parked for the client to come back, until its expiry, rather than refused while nobody attends. New sessions declare it. Capabilities are fixed at creation, so older sessions keep refusing.
- `message.appended` announces each turn's opening, and a message an interrupt appends, with `role` and `content` typed as `GET /messages` types them. A scheduled fire or a report opening a turn is this event, no longer an `info` notice, and a reader joining mid-turn is handed the opening after the resumed `turn.started`. The client shows it in the live preview instead of reading the opening from history after the first provider event.
- `inbox.deferred` names items whose turn failed in a way waiting can help, with `not_before` and `error`, and `inbox.failed` carries `error`. Inbox items and replays show `retry_until`, `not_before`, `last_error`, and `failure`. The client keeps a deferred item queued, shows when it runs again and why, and shows the reason meka gave up on one. meka sends each failed attempt's `turn.failed`, with `message_withdrawn`, before the deferral, so the client neither notifies nor keeps a notice for an inbox turn that ended so; an `inbox.failed` is reported as a notice instead, and notifies for the client's own item. A replayed inbox key whose item meka withdrew names why with `failure`, for a canceled turn as for a give-up, so the client says it was withdrawn.
- A turn's record and its terminal carry `profile` when a fallback profile served it, and `GET /v1/profiles` lists each profile's `fallbacks`. meka also says so in a notice, which the client shows.
- A blocking `POST /turn` lists the turn's opening message first; the client does not use blocking turns.
- The export archive is format 14.

0.79.0 adds `protocol_version` to a connected server in `GET /v1/mcp`, which the client shows, and exports archive format 15. 0.80.0 and 0.81.0 change no API; 0.81.0 moves two configuration keys the client never reads. 0.82.0 removes the Swagger UI at `/v1/docs`, which now answers 404, so Settings links to meka's online HTTP API reference; its schema differs from 0.80.0's only in its version.

0.83.0 changes these:

- A memory's `load`, `inline`, `index`, or `search`, decides how it reaches the agent's context, which priority 0 used to decide; priority is importance alone, and a priority-0 memory becomes `inline` on upgrade. A memory also carries `source`, `references`, `verified_at`, and `expires_at`, and its single read `referenced_by`. A write takes `load`, `source`, `references`, `expires`, and `verified`, each kept when omitted. The memory editor sets them and sends only what changed: meka stores a date's expiry as the moment that day ends, so sending it back unchanged would move it a day.
- `GET /v1/memory` lists every memory, search-only and expired ones included, and takes `referencing`, `unverified`, and `expired`. The memory page asks which have expired, so it marks them by meka's clock.
- `memory_edit` and `skill_edit` replace an exact string in a body, and are labeled by `name`.
- `tool_call.completed` carries `change`: the whole text a file, memory, or skill change left before and after. It is live only, and saved history replaces the live turn when it ends, so the client does not draw it. A large file's change can carry a completion past the parser's limit with a short result, which the parser keeps when it closes within the frame's kept head.

0.70.0 also adds turn records, the `/v1/stream` server feed, conditional rewind and fork through `ETag` and `If-Match`, `conversation.rewound`, `permission_resolved`, `approvals_pending`, the `parent` list filter, and the session's open `checklist` with `checklist.updated`. The client shows the open checklist above the message input. Notices are ephemeral: a running turn's show inline where they arrived, warnings and errors also stay below the conversation, and none survives a reload. The session feed parser ignores events it does not handle.

A shell command may print 64 MiB, all of which `tool_call.completed` carries, while the saved result stays a bounded preview. The SSE parser therefore skips data past 2,000,000 characters and keeps the frame's id, so a reconnect cannot replay it. A skipped tool completion keeps its call, outcome, and correlation from the ends of its JSON, and other skipped events become a notice.

The feed's 409 covers `session-not-loaded`: a token with only `sessions:r` does not load a session by attaching. The client then shows the saved conversation and retries the feed until the server loads the session. `POST /compact` runs as a turn on the feed, with `source: "compaction"` on `turn.started`; the client shows it as compacting and does not notify when it ends.

Schema capture is a manual maintenance step. Choose a disposable meka instance with `[serve].docs = true`, confirm its version, and download its schema. For a 0.83.0 instance listening on port 8081:

```sh
curl --fail --silent --show-error http://127.0.0.1:8081/v1/openapi.json --output docs/api/meka-0.83.0.json
npx prettier --write docs/api/meka-0.83.0.json
npm run api:generate
```

Review the captured version and schema diff before committing. When upgrading the baseline, update the versioned filename, generation command in `scripts/schema/package.json`, the minimum and verified versions in `src/api/version.ts`, and coverage documentation. Capture is separate from automated checks and does not start a meka process.

Generation uses an npm workspace with TypeScript 5 because openapi-typescript 7.13.0 declares a TypeScript 5 peer dependency. The application retains TypeScript 6. Generated types preserve the upstream wire schema, including nullable optional annotations, even though the API omits absent response values.

Problem Details use `https://meka.run/errors/`. The client also recognizes exact identifiers from the older `https://meka.so/errors/` namespace.

Session SSE validation is maintained separately in `src/session/events.ts`, against meka's HTTP frontend and API reference. Streaming responses are not a complete event schema. No private database schema or transcript replay implementation is duplicated here.

When upgrading meka, also compare `src/session/tool-summary.ts` with `builtin_primary_param` in meka's `src/tools.rs`. This fallback labels stored tool calls whose history responses have no `display_summary`; live calls use the server's resolved summary.

Generation uses `--empty-objects-unknown` because meka’s Problem Details extension object accepts arbitrary members. The command formats generated output so regeneration is reproducible, and CI checks that it produces no diff.
