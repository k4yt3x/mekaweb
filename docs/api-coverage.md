# API support

mekaweb targets **meka 0.59.0**, commit `22e1f6b3f1a78049429ef2ce2fd9f005e733368a`. The table maps supported HTTP operations to the interface. Available actions depend on the token's scopes and the server's configuration.

See the [captured schema and generation instructions](api/README.md) for the wire contract and the [meka HTTP API reference](https://github.com/k4yt3x/meka/blob/0.59.0/docs/book/src/usage/http-api.md) for server behavior.

| Method | Endpoint                                   | Interface support                                                           |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| GET    | `/v1/health/live`                          | Connection diagnostics                                                      |
| GET    | `/v1/health/ready`                         | Readiness and reported setup state                                          |
| GET    | `/v1/info`                                 | Version, permissions, scopes, and default vision information                |
| GET    | `/v1/profiles`                             | Profile inspection and session profile selection                            |
| POST   | `/v1/sessions`                             | Create with supported settings and capabilities                             |
| GET    | `/v1/sessions`                             | Cursor pagination and optional children                                     |
| GET    | `/v1/sessions/{id}`                        | Session details and activity                                                |
| PATCH  | `/v1/sessions/{id}`                        | Permission, approvals, cwd, and profile, with live-edit constraints         |
| DELETE | `/v1/sessions/{id}`                        | Confirmation and explicit Shift-click deletion                              |
| POST   | `/v1/sessions/{id}/fork`                   | Fork with supported overrides                                               |
| GET    | `/v1/sessions/{id}/messages`               | Paged history, revision, and compaction markers                             |
| GET    | `/v1/sessions/{id}/blobs/{hash}`           | Authenticated image display/download                                        |
| POST   | `/v1/sessions/{id}/turn`                   | Images, skills, retention options, and response reconciliation              |
| POST   | `/v1/sessions/{id}/cancel`                 | Cancel the observed turn id                                                 |
| POST   | `/v1/sessions/{id}/inbox`                  | Steer, follow-up, interrupt, and durable idempotency                        |
| GET    | `/v1/sessions/{id}/inbox`                  | Pending/appended items and delivery state                                   |
| DELETE | `/v1/sessions/{id}/inbox/{item_id}`        | Withdraw an eligible item                                                   |
| POST   | `/v1/sessions/{id}/responses/{request_id}` | Allow, deny, allow always, and deny always                                  |
| GET    | `/v1/sessions/{id}/stream`                 | Attendance, replay, lifecycle, content, tools, progress, inbox, and notices |
| POST   | `/v1/sessions/{id}/compact`                | Explicit compaction and its result                                          |
| GET    | `/v1/sessions/{id}/context`                | Context capacity, cumulative usage, and cache hit rate                      |
| POST   | `/v1/sessions/{id}/rewind`                 | Confirmed rewind and history refresh                                        |
| GET    | `/v1/sessions/{id}/export`                 | Full-transcript Markdown and JSON archive downloads                         |
| POST   | `/v1/sessions/import`                      | Import a supported JSON session tree                                        |
| GET    | `/v1/sessions/{id}/tools`                  | Tool catalog, including nonresident state                                   |
| GET    | `/v1/sessions/{id}/tasks`                  | Background tasks and outcomes                                               |
| DELETE | `/v1/sessions/{id}/tasks/{task_id}`        | Task cancellation with ownership limitations                                |
| GET    | `/v1/schedule`                             | Global job listing                                                          |
| GET    | `/v1/sessions/{id}/schedule`               | Session job listing                                                         |
| POST   | `/v1/sessions/{id}/schedule`               | One-time and recurring jobs, with supported gates                           |
| DELETE | `/v1/schedule/{job_id}`                    | Job cancellation                                                            |
| GET    | `/v1/skills`                               | Skill index and selection                                                   |
| GET    | `/v1/skills/{name}`                        | Skill body and metadata                                                     |
| PUT    | `/v1/skills/{name}`                        | Create/update with supported fields                                         |
| DELETE | `/v1/skills/{name}`                        | Delete; explain read-only skill locations                                   |
| GET    | `/v1/memory`                               | Memory index and local search                                               |
| GET    | `/v1/memory/{name}`                        | Memory body and metadata                                                    |
| PUT    | `/v1/memory/{name}`                        | Create/update with omitted-versus-empty semantics                           |
| DELETE | `/v1/memory/{name}`                        | Memory deletion                                                             |
| GET    | `/v1/mcp`                                  | Actual MCP connection states                                                |
| GET    | `/v1/mcp/{name}/tools`                     | Tools, permissions, and filtering explanations                              |
| POST   | `/v1/mcp/{name}/reconnect`                 | Reconnect and inspect returned state                                        |
| GET    | `/v1/instructions`                         | Resolved standing instructions                                              |
| GET    | `/v1/openapi.json`                         | Optional schema link/download, tolerating disabled docs                     |
| GET    | `/v1/docs`                                 | Optional Swagger UI link, tolerating disabled docs                          |

## Limits and behavior

- **Sessions:** Lists use cursor pagination and can include sub-agents. Session-content search is not exposed by this API; the interface does not offer a working-directory filter. Fork supports a working-directory override. Directory/profile changes require an idle session, while permission and approval mode can change during a turn.
- **Sub-agents:** Their parent drives them. Their history, context, and tasks can be inspected, but they cannot receive direct user turns or independent settings changes.
- **History:** Compaction and rewind alter model context. Live replay is bounded and cannot serve as a complete transcript. Export supports Markdown transcripts and JSON archives.
- **Images and skills:** These use direct turns while idle; the inbox accepts text only. Skill activation is available from composer Settings.
- **Memory:** Search filters the complete returned index; this release has no memory pagination or server-side filter parameters. Editing preserves omitted-versus-empty body and tag values.
- **Skills:** Editable fields are those accepted by the write API. Author is creation-only; version, compatibility, license, and allowed-tools metadata are read-only. The server may reject writes to read-only skill locations.
- **Schedules:** One-time timestamps/durations, intervals, cron expressions, and shell/tool gates are supported. Gate predicates include changes, success, regular expressions, and JSON-pointer conditions. Retention is server-owned, and gate details may be withheld without `sessions:r`.
- **MCP:** Server status, tool catalogs, and reconnect are available. MCP configuration, login, and interactive elicitation are not exposed by this API.
- **Profiles and instructions:** These are read-only through the HTTP API. Configure them in meka.
- **Documentation:** OpenAPI and Swagger endpoints are optional and require `[serve].docs` on the server.

See the [README](../README.md) for connection setup, recovery guidance, and browser compatibility, and the [architecture](architecture.md) for credential and state-handling invariants.
