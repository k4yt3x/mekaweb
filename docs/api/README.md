# API schema maintenance

`meka-0.64.0.json` was captured from meka tag `0.64.0`, commit `e639b7843138d603aff34bd329ee90423b306510`, through `/v1/openapi.json` with `[serve].docs = true`. The generated REST types are committed in `src/api/schema.d.ts`; runtime connections do not require schema access.

Meka 0.64.1, commit `c17a5f7c596d229dd716a543ddd380c450471c98`, was reviewed against that baseline. Its fix removes duplicate environment context from sub-agent prompts; REST shapes, SSE events, and tool parameters are unchanged. The 0.64.0 schema remains the generation source.

Schema capture is a manual maintenance step. Choose a disposable meka instance with `[serve].docs = true`, confirm its version, and download its schema. For a 0.64.0 instance listening on port 8081:

```sh
curl --fail --silent --show-error http://127.0.0.1:8081/v1/openapi.json --output docs/api/meka-0.64.0.json
npx prettier --write docs/api/meka-0.64.0.json
npm run api:generate
```

Review the captured version and schema diff before committing. When upgrading the baseline, update the versioned filename, generation command in `scripts/schema/package.json`, diagnostics, and coverage documentation. Capture is separate from automated checks and does not start a meka process.

Generation uses an npm workspace with TypeScript 5 because openapi-typescript 7.13.0 declares a TypeScript 5 peer dependency. The application retains TypeScript 6. Generated types preserve the upstream wire schema, including nullable optional annotations, even though the API omits absent response values.

Compared with 0.60.0, the 0.64.0 schema adds session search, title and pin PATCH fields, and `pinned_at` on session responses. Since 0.63.0, inbox items omit `source` when none was supplied. Other REST shapes and the SSE event contract are unchanged. Archives can now carry titles and pins; the client passes archive documents through without rewriting them.

Session organization controls use the discovered server version and require 0.64.0 or later. Older supported servers keep their existing flows without receiving unsupported search requests or metadata fields.

Problem Details use `https://meka.run/errors/`. The client also recognizes exact identifiers from the older `https://meka.so/errors/` namespace.

Session SSE validation is maintained separately in `src/session/events.ts`, against meka's HTTP frontend and API reference. Streaming responses are not a complete event schema. No private database schema or transcript replay implementation is duplicated here.

When upgrading meka, also compare `src/session/tool-summary.ts` with `builtin_primary_param` in meka's `src/tools.rs`. This fallback labels stored tool calls whose history responses have no `display_summary`; live calls use the server's resolved summary.

Generation uses `--empty-objects-unknown` because meka’s Problem Details extension object accepts arbitrary members. The command formats generated output so regeneration is reproducible, and CI checks that it produces no diff.
