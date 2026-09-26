# API support

mekaweb targets **meka 0.65.0**, commit `61de2537fcfd3bb16ee1b46748254f40a399ac48`. Meka 0.59.0–0.64.1 retain their existing features; titles, pins, and conversation search require 0.64.0. The table maps supported HTTP operations to the interface. Available actions depend on the token's scopes and the server's configuration.

See the [captured schema and generation instructions](api/README.md) for the wire contract and the [meka HTTP API reference](https://github.com/k4yt3x/meka/blob/0.65.0/docs/book/src/usage/http-api.md) for server behavior.

| Method | Endpoint                                   | Interface support                                                               |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| GET    | `/v1/health/live`                          | Connection diagnostics                                                          |
| GET    | `/v1/health/ready`                         | Readiness and reported setup state                                              |
| GET    | `/v1/info`                                 | Version, permissions, scopes, and default vision information                    |
| GET    | `/v1/profiles`                             | Profile inspection and session profile selection                                |
| POST   | `/v1/sessions`                             | Create with supported settings and capabilities                                 |
| GET    | `/v1/sessions`                             | Pinned-first cursor pagination and optional children                            |
| GET    | `/v1/sessions/search`                      | Conversation and title search, excerpts, and optional children                  |
| GET    | `/v1/sessions/{id}`                        | Session details and activity                                                    |
| PATCH  | `/v1/sessions/{id}`                        | Permission, approvals, cwd, profile, title, and pin, with live-edit constraints |
| DELETE | `/v1/sessions/{id}`                        | Confirmation and explicit Shift-click deletion                                  |
| POST   | `/v1/sessions/{id}/fork`                   | Fork with supported overrides                                                   |
| GET    | `/v1/sessions/{id}/messages`               | Paged history, revision, and compaction markers                                 |
| GET    | `/v1/sessions/{id}/blobs/{hash}`           | Authenticated image display/download                                            |
| POST   | `/v1/sessions/{id}/turn`                   | Streaming idle turns, images, skills, retention, and recovery                   |
| POST   | `/v1/sessions/{id}/cancel`                 | Cancel the observed turn id                                                     |
| POST   | `/v1/sessions/{id}/inbox`                  | Steer, follow-up, interrupt, and durable idempotency                            |
| GET    | `/v1/sessions/{id}/inbox`                  | Pending/appended items and delivery state                                       |
| DELETE | `/v1/sessions/{id}/inbox/{item_id}`        | Withdraw an eligible item                                                       |
| POST   | `/v1/sessions/{id}/responses/{request_id}` | Allow, deny, allow always, and deny always                                      |
| GET    | `/v1/sessions/{id}/stream`                 | Attendance, replay, lifecycle, content, tools, progress, inbox, and notices     |
| POST   | `/v1/sessions/{id}/compact`                | Explicit compaction and its result                                              |
| GET    | `/v1/sessions/{id}/context`                | Context capacity, cumulative usage, and cache hit rate                          |
| POST   | `/v1/sessions/{id}/rewind`                 | Confirmed rewind and history refresh                                            |
| GET    | `/v1/sessions/{id}/export`                 | Full-transcript Markdown and JSON archive downloads                             |
| POST   | `/v1/sessions/import`                      | Import a supported JSON session tree                                            |
| GET    | `/v1/sessions/{id}/tools`                  | Tool catalog, including nonresident state                                       |
| GET    | `/v1/sessions/{id}/tasks`                  | Background tasks and outcomes                                                   |
| DELETE | `/v1/sessions/{id}/tasks/{task_id}`        | Task cancellation with ownership limitations                                    |
| GET    | `/v1/schedule`                             | Global job listing                                                              |
| GET    | `/v1/sessions/{id}/schedule`               | Session job listing                                                             |
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

- **Sessions:** Lists use cursor pagination and can include sub-agents. Search returns up to 100 matches in server relevance order, including conversation text and titles. It excludes thinking and tool inputs/results. Refine the query when the result limit is reached; the search API has no pagination. Listings group loaded sub-agents beneath their parents, retaining the server’s pin and recency order among roots and siblings. Titles can be reset to the first message; neither renaming nor pinning changes `updated_at`. The interface does not offer a working-directory filter. Fork supports a working-directory override. Directory/profile changes require an idle session, while permission, approval mode, titles, and pins can change during a turn.
- **Sub-agents:** Their parent drives them. Their history, context, and tasks can be inspected, but they cannot receive direct user turns or independent settings, title, or pin changes through the HTTP API. Meka 0.64.1 stops prepending environment context to their task text, so new sub-agent titles show the assigned task. Older stored prompts are unchanged.
- **History:** Compaction and rewind alter model context. Live replay is bounded and cannot serve as a complete transcript. Export supports Markdown transcripts and JSON archives. Meka 0.65.0 exports archive format 5 and imports formats 3 through 5; older data conversion is handled by the server. Since 0.65.0, compaction summaries quote the most recent messages received as they were written; the summary view renders them as block quotes.
- **Images and skills:** These use direct turns while idle; the inbox accepts text only. Skill activation is available from composer Settings.
- **Sending:** Idle text uses a direct streaming turn; busy text uses the selected inbox mode. Only an explicit `turn-in-flight` conflict permits a text-only fallback to the inbox. Streaming turns are never retried automatically. The session feed supplies displayed events and approvals; the POST stream tracks admission and the submitted turn's outcome.
- **Memory:** Search filters the complete returned index; this release has no memory pagination or server-side filter parameters. Editing preserves omitted-versus-empty body and tag values.
- **Skills:** Editable fields are those accepted by the write API. Author is creation-only; version, compatibility, license, and allowed-tools metadata are read-only. The server may reject writes to read-only skill locations.
- **Schedules:** One-time timestamps/durations, intervals, cron expressions, and shell/tool gates are supported. Gate predicates include changes, success, regular expressions, and JSON-pointer conditions. Retention is server-owned, and gate details may be withheld without `sessions:r`.
- **MCP:** Server status, tool catalogs, and reconnect are available. MCP configuration, login, and interactive elicitation are not exposed by this API.
- **Profiles and instructions:** These are read-only through the HTTP API. Configure them in meka. `/instructions` returns standing instructions, excluding the per-session files named in `[instructions]`.
- **Documentation:** OpenAPI and Swagger endpoints are optional and require `[serve].docs` on the server.

See the [README](../README.md) for connection setup, recovery guidance, and browser compatibility, and the [architecture](architecture.md) for credential and state-handling invariants.

Built-in tool names changed in meka 0.60.0, and `tool_search` was added. The interface displays tool names from the server without translating them. Update old names in custom skill bodies, standing instructions, and new tool-gate definitions using the [meka upgrade guide](https://github.com/k4yt3x/meka/blob/0.60.0/docs/book/src/getting-started/upgrading.md#059-to-060). Existing stored sessions, tasks, and gates are migrated by meka.
