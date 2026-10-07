# API support

mekaweb targets **meka 0.71.0**, commit `8940142b8b37718b36b5a19c8458f185827717d7`. It refuses older servers when connecting, since 0.70.0 reshaped the API and 0.71.0 changed how feeds report a gap. The table maps supported HTTP operations to the interface. Available actions depend on the token's scopes and the server's configuration.

See the [captured schema and generation instructions](api/README.md) for the wire contract and the [meka HTTP API reference](https://github.com/k4yt3x/meka/blob/0.71.0/docs/book/src/usage/http-api.md) for server behavior.

| Method | Endpoint                                   | Interface support                                                               |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| GET    | `/v1/health/live`                          | Connection diagnostics                                                          |
| GET    | `/v1/health/ready`                         | Readiness and reported setup state                                              |
| GET    | `/v1/info`                                 | Version check, permissions, and scopes                                          |
| GET    | `/v1/profiles`                             | Profile inspection, image support, and session profile selection                |
| POST   | `/v1/sessions`                             | Create with supported settings and capabilities                                 |
| GET    | `/v1/sessions`                             | Pinned-first pagination, statuses, and one session's sub-agents                 |
| GET    | `/v1/sessions/search`                      | Conversation and title search, excerpts, and sub-agents                         |
| GET    | `/v1/sessions/{id}`                        | Session details and activity                                                    |
| PATCH  | `/v1/sessions/{id}`                        | Permission, approvals, cwd, profile, title, and pin, with live-edit constraints |
| DELETE | `/v1/sessions/{id}`                        | Confirmation and explicit Shift-click deletion                                  |
| POST   | `/v1/sessions/{id}/fork`                   | Fork with supported overrides, and conditional branching from a turn            |
| GET    | `/v1/sessions/{id}/messages`               | Paged history, revision, compaction markers, and `ETag` for history edits       |
| GET    | `/v1/sessions/{id}/blobs/{hash}`           | Authenticated image display/download                                            |
| POST   | `/v1/sessions/{id}/turn`                   | Streaming idle turns, images, skills, retention, and recovery                   |
| POST   | `/v1/sessions/{id}/cancel`                 | Cancel the observed turn id                                                     |
| POST   | `/v1/sessions/{id}/inbox`                  | Steer, follow-up, interrupt, and durable idempotency                            |
| GET    | `/v1/sessions/{id}/inbox`                  | Pending/appended items and delivery state                                       |
| DELETE | `/v1/sessions/{id}/inbox/{item_id}`        | Withdraw an eligible item                                                       |
| POST   | `/v1/sessions/{id}/responses/{request_id}` | Allow, deny, allow always, and deny always, including for sub-agents            |
| GET    | `/v1/stream`                               | Live session list and statuses across sessions                                  |
| GET    | `/v1/sessions/{id}/stream`                 | Attendance, replay, lifecycle, content, tools, inbox, and live sub-agents       |
| POST   | `/v1/sessions/{id}/compact`                | Explicit compaction and its result                                              |
| GET    | `/v1/sessions/{id}/context`                | Context capacity, cumulative usage, and cache hit rate                          |
| POST   | `/v1/sessions/{id}/rewind`                 | Rewind, and conditional delete, edit, and run-again message actions             |
| GET    | `/v1/sessions/{id}/export`                 | Full-transcript Markdown and JSON archive downloads                             |
| POST   | `/v1/sessions/import`                      | Import a supported JSON session tree                                            |
| GET    | `/v1/sessions/{id}/tools`                  | Tool catalog, including nonresident state                                       |
| GET    | `/v1/sessions/{id}/tasks`                  | Background tasks and outcomes                                                   |
| DELETE | `/v1/sessions/{id}/tasks/{task_id}`        | Task cancellation with ownership limitations                                    |
| GET    | `/v1/schedule`                             | Global and per-session job listings                                             |
| POST   | `/v1/sessions/{id}/schedule`               | One-time and recurring jobs, with supported gates                               |
| DELETE | `/v1/schedule/{job_id}`                    | Job cancellation                                                                |
| GET    | `/v1/skills`                               | Skill index and selection                                                       |
| GET    | `/v1/skills/{name}`                        | Skill body and metadata                                                         |
| PUT    | `/v1/skills/{name}`                        | Create/update with supported fields                                             |
| DELETE | `/v1/skills/{name}`                        | Delete; explain read-only skill locations                                       |
| GET    | `/v1/memory`                               | Memory index and local search                                                   |
| GET    | `/v1/memory/{name}`                        | Memory body and metadata                                                        |
| PUT    | `/v1/memory/{name}`                        | Create/update with omitted-versus-empty semantics                               |
| DELETE | `/v1/memory/{name}`                        | Memory deletion                                                                 |
| GET    | `/v1/mcp`                                  | Actual MCP connection states                                                    |
| GET    | `/v1/mcp/{name}/tools`                     | Tools, permissions, and filtering explanations                                  |
| POST   | `/v1/mcp/{name}/reconnect`                 | Reconnect and inspect returned state                                            |
| GET    | `/v1/instructions`                         | Resolved standing instructions                                                  |
| GET    | `/v1/openapi.json`                         | Optional schema link/download, tolerating disabled docs                         |
| GET    | `/v1/docs`                                 | Optional Swagger UI link, tolerating disabled docs                              |

## Limits and behavior

- **Sessions:** Lists use cursor pagination and hold top-level sessions; a session's sub-agents are read with `parent` when it is unfolded. Search includes sub-agents. Search returns up to 100 matches in server relevance order, including conversation text and titles. It excludes thinking and tool inputs/results. Refine the query when the result limit is reached; the search API has no pagination. Listings group loaded sub-agents beneath their parents, retaining the server’s pin and recency order among roots and siblings. Titles can be reset to the first message; neither renaming nor pinning changes `updated_at`. The interface does not offer a working-directory filter. Fork supports a working-directory override. Directory/profile changes require an idle session, while permission, approval mode, titles, and pins can change during a turn.
- **Read-only tokens:** A token without `sessions:w` cannot load a session by opening its feed. The interface shows the saved conversation and retries the feed every 15 seconds until the server loads the session, such as when a client with write access opens it.
- **Sub-agents:** Their parent drives them. Their history, context, and tasks can be inspected, and a running sub-agent's feed is shown live, but they cannot receive direct user turns or independent settings, title, or pin changes through the HTTP API. The parent's feed carries a sub-agent's approval prompts.
- **History:** Compaction and rewind alter model context. Live replay is bounded and cannot serve as a complete transcript. Export supports Markdown transcripts and JSON archives. Meka 0.71.0 exports archive format 9 and imports formats 3 through 9; older data conversion is handled by the server. Compaction summaries quote the most recent messages received as they were written; the summary view renders them as block quotes. An explicit compaction runs as a turn, shown as compacting, without a completion notification. Stop ends its checkpoint early, and meka still writes the summary.
- **Images and skills:** These use direct turns while idle; the inbox accepts text only. Skill activation is available from composer Settings.
- **Sending:** Idle text uses a direct streaming turn; busy text uses the selected inbox mode. Only an explicit `turn-in-flight` conflict permits a text-only fallback to the inbox. Streaming turns are never retried automatically. The session feed supplies displayed events and approvals; the POST stream tracks admission and the submitted turn's outcome.
- **Memory:** Search filters the complete returned index; this release has no memory pagination or server-side filter parameters. Editing preserves omitted-versus-empty body and tag values.
- **Skills:** Editable fields are those accepted by the write API. Author is creation-only; version, compatibility, license, and allowed-tools metadata are read-only. The server may reject writes to read-only skill locations.
- **Schedules:** One-time timestamps/durations, intervals, cron expressions, and shell/tool gates are supported. Gate predicates include changes, success, regular expressions, and JSON-pointer conditions. Retention is server-owned, and gate details may be withheld without `sessions:r`.
- **MCP:** Server status, tool catalogs, and reconnect are available. MCP configuration, login, and interactive elicitation are not exposed by this API.
- **Profiles and instructions:** These are read-only through the HTTP API. Configure them in meka. `/instructions` returns standing instructions, excluding the per-session files named in `[instructions]`.
- **Documentation:** OpenAPI and Swagger endpoints are optional and require `[serve].docs` on the server.

See [using mekaweb](usage.md) for connection setup, recovery guidance, and browser compatibility, and the [architecture](architecture.md) for credential and state-handling invariants.
