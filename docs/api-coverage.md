# API support

mekaweb targets **meka 0.84.0**, commit `b14735f9f2892578b5c54d762a0305eb14e2109e`, and refuses older servers: the minimum and the verified versions are in `web/src/api/meka-versions.json`, which mekaweb's server checks too. The interface reaches meka through mekaweb at `/meka/v1/…`, which adds a token with every scope. The table maps supported HTTP operations to the interface.

See the [captured schema and generation instructions](api/README.md) for the wire contract and the [meka HTTP API reference](https://github.com/k4yt3x/meka/blob/0.84.0/docs/book/src/usage/http-api.md) for server behavior.

| Method | Endpoint                                   | Interface support                                                                        |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| GET    | `/v1/health/live`                          | Connection diagnostics                                                                   |
| GET    | `/v1/health/ready`                         | Readiness and reported setup state                                                       |
| GET    | `/v1/info`                                 | Version check, permissions, and scopes                                                   |
| GET    | `/v1/profiles`                             | Profile inspection, image support, and session profile selection                         |
| POST   | `/v1/sessions`                             | Create with supported settings, a project, and capabilities                              |
| GET    | `/v1/sessions`                             | Pinned-first pagination, statuses, and one session's sub-agents                          |
| GET    | `/v1/sessions/search`                      | Conversation and title search, excerpts, and sub-agents                                  |
| GET    | `/v1/sessions/{id}`                        | Session details and activity                                                             |
| PATCH  | `/v1/sessions/{id}`                        | Permission, approvals, working directory, profile, project, title, pin, live-edit limits |
| DELETE | `/v1/sessions/{id}`                        | Confirmation and explicit Shift-click deletion                                           |
| POST   | `/v1/sessions/{id}/fork`                   | Fork with supported overrides, and conditional branching from a turn                     |
| GET    | `/v1/sessions/{id}/messages`               | Paged history, revision, compaction markers, and `ETag` for history edits                |
| GET    | `/v1/sessions/{id}/blobs/{hash}`           | Authenticated image display/download                                                     |
| POST   | `/v1/sessions/{id}/turn`                   | Detached idle turns, images, skills, retention, and safe retries                         |
| GET    | `/v1/sessions/{id}/turns`                  | Each ended turn's summary: when it ended, how long it ran, and what it spent             |
| GET    | `/v1/sessions/{id}/turns/{turn_id}`        | The ending of a sent turn whose terminal the feed did not deliver                        |
| POST   | `/v1/sessions/{id}/cancel`                 | Cancel the observed turn id                                                              |
| POST   | `/v1/sessions/{id}/inbox`                  | Steer, follow-up, interrupt, and durable idempotency                                     |
| GET    | `/v1/sessions/{id}/inbox`                  | Pending/appended items, delivery state, and retries after a failed turn                  |
| DELETE | `/v1/sessions/{id}/inbox/{item_id}`        | Withdraw an eligible item                                                                |
| POST   | `/v1/sessions/{id}/responses/{request_id}` | Allow, deny, allow always, and deny always, including for sub-agents                     |
| GET    | `/v1/stream`                               | Live session list and statuses across sessions                                           |
| GET    | `/v1/sessions/{id}/stream`                 | Attendance, replay, lifecycle, content, tools, inbox, and live sub-agents                |
| POST   | `/v1/sessions/{id}/compact`                | Explicit compaction and its result                                                       |
| GET    | `/v1/sessions/{id}/context`                | Context capacity, cumulative usage, and cache hit rate                                   |
| POST   | `/v1/sessions/{id}/rewind`                 | Rewind, and conditional delete, edit, and run-again message actions                      |
| GET    | `/v1/sessions/{id}/export`                 | Full-transcript Markdown and JSON archive downloads                                      |
| POST   | `/v1/sessions/import`                      | Import a supported JSON session tree                                                     |
| GET    | `/v1/sessions/{id}/tools`                  | Tool catalog, including nonresident state                                                |
| GET    | `/v1/sessions/{id}/tasks`                  | Background tasks and outcomes                                                            |
| DELETE | `/v1/sessions/{id}/tasks/{task_id}`        | Task cancellation with ownership limitations                                             |
| GET    | `/v1/schedule`                             | Global and per-session job listings                                                      |
| POST   | `/v1/sessions/{id}/schedule`               | One-time and recurring jobs, with supported gates                                        |
| DELETE | `/v1/schedule/{job_id}`                    | Job cancellation                                                                         |
| GET    | `/v1/skills`                               | Skill index and selection                                                                |
| GET    | `/v1/skills/{name}`                        | Skill body and metadata                                                                  |
| PUT    | `/v1/skills/{name}`                        | Create/update with supported fields                                                      |
| DELETE | `/v1/skills/{name}`                        | Delete; explain read-only skill locations                                                |
| GET    | `/v1/memory`                               | Memory index, meka's search with snippets, a project filter, and which have expired      |
| GET    | `/v1/memory/{name}`                        | Memory body and metadata                                                                 |
| PUT    | `/v1/memory/{name}`                        | Create in a project or update, with omitted-versus-empty semantics                       |
| DELETE | `/v1/memory/{name}`                        | Memory deletion                                                                          |
| GET    | `/v1/projects`                             | Projects with their memory and session counts, and project selection                     |
| POST   | `/v1/projects`                             | Add a project                                                                            |
| PATCH  | `/v1/projects/{name}`                      | Rename a project                                                                         |
| DELETE | `/v1/projects/{name}`                      | Remove a project nothing is on                                                           |
| GET    | `/v1/mcp`                                  | Actual MCP connection states and protocol versions                                       |
| GET    | `/v1/mcp/{name}/tools`                     | Tools, permissions, deferral, and filtering explanations                                 |
| POST   | `/v1/mcp/{name}/reconnect`                 | Reconnect and inspect returned state                                                     |
| GET    | `/v1/instructions`                         | Resolved standing instructions                                                           |

## Limits and behavior

- **Sessions:** Lists use cursor pagination and hold top-level sessions; a session's sub-agents are read with `parent` when it is unfolded. Search includes sub-agents. Search returns up to 100 matches in server relevance order, including conversation text and titles. It excludes thinking and tool inputs/results. Refine the query when the result limit is reached; the search API has no pagination. Listings group loaded sub-agents beneath their parents, retaining the server’s pin and recency order among roots and siblings. Titles can be reset to the first message; neither renaming nor pinning changes `updated_at`. The interface does not offer a working-directory or project filter. Fork supports a working-directory override. Directory, profile, and project changes require an idle session, while permission, approval mode, titles, and pins can change during a turn.
- **Read-only tokens:** mekaweb's token has every scope. Should meka refuse a feed with `session-not-loaded`, the interface shows the saved conversation and retries the feed every 15 seconds until the server loads the session.
- **Sub-agents:** Their parent drives them. Their history, context, and tasks can be inspected, and a running sub-agent's feed is shown live, but they cannot receive direct user turns or independent settings, title, or pin changes through the HTTP API. The parent's feed carries a sub-agent's approval prompts.
- **History:** Compaction and rewind alter model context. With `[session].turn_retention` set, meka deletes turns a compaction summarized once they age past the window, so the history starts at what remains. Live replay is bounded and cannot serve as a complete transcript. Export supports Markdown transcripts and JSON archives. Meka 0.84.0 exports archive format 16 and imports formats 3 through 16; older data conversion is handled by the server. What meka writes into a conversation on another's behalf keeps its kind: an inbox item shows as its sender's words, and a scheduled fire or a background report as meka's note, inside a running turn when a report reached it at a tool round's end. Compaction summaries quote the most recent messages received as they were written; the summary view renders them as block quotes. A compaction shows as compacting from `context.compacting` until it lands or fails, and its summary says what set it going, in meka's words; an explicit one runs as a turn, without a completion notification. Stop ends its checkpoint early, and meka still writes the summary.
- **Images and skills:** These use direct turns while idle; the inbox accepts text only. Skill activation is available from composer Settings.
- **Sending:** Idle text uses a detached turn, which runs on when the tab closes; busy text uses the selected inbox mode. Only an explicit `turn-in-flight` conflict permits a text-only fallback to the inbox. A send whose outcome is unknown is retried only on request, under its original key. The session feed supplies displayed events, approvals, and the turn's outcome; the turn's record settles one the feed missed. New sessions keep an approval prompt waiting for the user to return.
- **Memory:** The page lists every memory, search-only and expired ones included. Search is meka's own, the one the agent's `memory_search` uses, so it reads bodies too; it shows the 25 best matches, each with the words it was found on. The page asks meka which memories have expired, and offers no `referencing` or `unverified` filter. Editing sends only the fields that changed, preserving meka's omitted-versus-empty rule for the body, tags, load, expiry, source, and references. An expiry is picked as the last day it applies, which meka reads in its own time zone. **Mark as verified** moves the verification stamp, which nothing else moves. A project memory's card names its project, and the page opens, saves, and deletes it in that tier, since projects may share a name. A memory is filed in a project when it is made, and the page does not move it: meka moves a memory between the global tier and a project, but a write naming another project for a project's memory adds a memory there.
- **Skills:** Editable fields are those accepted by the write API. Author is creation-only; version, compatibility, license, and allowed-tools metadata are read-only. The server may reject writes to read-only skill locations.
- **Schedules:** One-time timestamps/durations, intervals, cron expressions, and shell/tool gates are supported. Gate predicates include changes, success, regular expressions, and JSON-pointer conditions. Retention is server-owned, and gate details may be withheld without `sessions:r`.
- **MCP:** Server status, tool catalogs, and reconnect are available. MCP configuration, login, and interactive elicitation are not exposed by this API.
- **Profiles and instructions:** These are read-only through the HTTP API. Configure them in meka. `/instructions` returns standing instructions, excluding the per-session files named in `[instructions]`.
- **Documentation:** mekaweb does not pass `/v1/openapi.json` through. meka 0.82.0 removed its Swagger UI, so Settings links to meka's online HTTP API reference instead.

See [using mekaweb](usage.md) for connection setup, recovery guidance, and browser compatibility, and the [architecture](architecture.md) for credential and state-handling invariants.
