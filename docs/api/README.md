# API schema maintenance

`meka-0.71.0.json` was captured from meka tag `0.71.0`, commit `8940142b8b37718b36b5a19c8458f185827717d7`, through `/v1/openapi.json` with `[serve].docs = true`. The generated REST types are committed in `src/api/schema.d.ts`; runtime connections do not require schema access.

mekaweb requires meka 0.71.0 or newer and refuses older servers during connection discovery. Compared with 0.68.0, the 0.70.0 and 0.71.0 APIs change these shapes the client used:

- `/v1/info` no longer reports `vision`; each `/v1/profiles` entry does.
- `/v1/sessions/{id}/context` no longer reports `used_percent`. The client divides `used` by `window`, rounding down as meka did.
- `GET /v1/sessions/{id}/schedule` is gone; `GET /v1/schedule?session=<id>` lists one session's jobs.
- A message's `turn_id` is the id of the turn that added it, shared by its tool results; the positional label moved to `turn_label`. Message actions count the turns a rewind drops by `turn_label`, the rule meka's rewind counts by.
- `subagent.activity` is gone from the session feed. A running sub-agent has a read-only feed of its own.
- The `todo_*` tools are `checklist_add`, `checklist_edit`, and `checklist_read`. meka renames them in stored history, so the client labels only the new names.
- A hole in a feed is a `feed.gap` event, no longer a `notice`, and a reader that falls behind is caught up rather than told to re-attach. A notice is only what the agent or a provider said.
- A turn's `images` take `{hash}` for an image the session's history holds, so a message is sent again without uploading its images. `ImageInput` therefore types every field as optional; the client keeps its own types for an attached image and a stored one.
- A message meka writes to send the model back to work opens with a `nudge` block. It stays in the agent's turn, is not counted as a turn, and arrives live as `turn.nudged`.

0.70.0 also adds turn records, the `/v1/stream` server feed, conditional rewind and fork through `ETag` and `If-Match`, `conversation.rewound`, `permission_resolved`, `approvals_pending`, the `parent` list filter, and the session's open `checklist` with `checklist.updated`. The client shows the open checklist above the message input. Notices are ephemeral: a running turn's show inline where they arrived, warnings and errors also stay below the conversation, and none survives a reload. The session feed parser ignores events it does not handle.

A shell command may print 64 MiB, all of which `tool_call.completed` carries, while the saved result stays a bounded preview. The SSE parser therefore skips data past 2,000,000 characters and keeps the frame's id, so a reconnect cannot replay it. A skipped tool completion keeps its call, outcome, and correlation from the ends of its JSON, and other skipped events become a notice.

The feed's 409 covers `session-not-loaded`: a token with only `sessions:r` does not load a session by attaching. The client then shows the saved conversation and retries the feed until the server loads the session. `POST /compact` runs as a turn on the feed, with `source: "compaction"` on `turn.started`; the client shows it as compacting and does not notify when it ends.

Schema capture is a manual maintenance step. Choose a disposable meka instance with `[serve].docs = true`, confirm its version, and download its schema. For a 0.71.0 instance listening on port 8081:

```sh
curl --fail --silent --show-error http://127.0.0.1:8081/v1/openapi.json --output docs/api/meka-0.71.0.json
npx prettier --write docs/api/meka-0.71.0.json
npm run api:generate
```

Review the captured version and schema diff before committing. When upgrading the baseline, update the versioned filename, generation command in `scripts/schema/package.json`, the minimum and verified versions in `src/api/version.ts`, and coverage documentation. Capture is separate from automated checks and does not start a meka process.

Generation uses an npm workspace with TypeScript 5 because openapi-typescript 7.13.0 declares a TypeScript 5 peer dependency. The application retains TypeScript 6. Generated types preserve the upstream wire schema, including nullable optional annotations, even though the API omits absent response values.

Problem Details use `https://meka.run/errors/`. The client also recognizes exact identifiers from the older `https://meka.so/errors/` namespace.

Session SSE validation is maintained separately in `src/session/events.ts`, against meka's HTTP frontend and API reference. Streaming responses are not a complete event schema. No private database schema or transcript replay implementation is duplicated here.

When upgrading meka, also compare `src/session/tool-summary.ts` with `builtin_primary_param` in meka's `src/tools.rs`. This fallback labels stored tool calls whose history responses have no `display_summary`; live calls use the server's resolved summary.

Generation uses `--empty-objects-unknown` because meka’s Problem Details extension object accepts arbitrary members. The command formats generated output so regeneration is reproducible, and CI checks that it produces no diff.
