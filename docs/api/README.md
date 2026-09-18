# API schema maintenance

`meka-0.60.0.json` was captured from meka tag `0.60.0`, commit `d5f7d219a3d02c109d96862f35fa84ef41f1ccb6`, through `/v1/openapi.json` with `[serve].docs = true`. The generated REST types are committed in `src/api/schema.d.ts`; runtime connections do not require schema access.

Schema capture is a manual maintenance step. Choose a disposable meka instance with `[serve].docs = true`, confirm its version, and download its schema. For a 0.60.0 instance listening on port 8081:

```sh
curl --fail --silent --show-error http://127.0.0.1:8081/v1/openapi.json --output docs/api/meka-0.60.0.json
npx prettier --write docs/api/meka-0.60.0.json
npm run api:generate
```

Review the captured version and schema diff before committing. When upgrading the baseline, update the versioned filename, generation command in `scripts/schema/package.json`, diagnostics, and coverage documentation. Capture is separate from automated checks and does not start a meka process.

Generation uses an npm workspace with TypeScript 5 because openapi-typescript 7.13.0 declares a TypeScript 5 peer dependency. The application retains TypeScript 6. Generated types preserve the upstream wire schema, including nullable optional annotations, even though the API omits absent response values.

Compared with 0.59.0, the 0.60.0 capture changes the version and three tool-description strings; REST request/response shapes and operation paths are unchanged. Archive format changes are managed by meka, and the client passes archive documents through without rewriting them.

Problem Details use `https://meka.run/errors/`. The client also recognizes exact identifiers from the older `https://meka.so/errors/` namespace.

Session SSE validation is maintained separately in `src/session/events.ts`, against meka's HTTP frontend and API reference. Streaming responses are not a complete event schema. No private database schema or transcript replay implementation is duplicated here.

Generation uses `--empty-objects-unknown` because meka’s Problem Details extension object accepts arbitrary members. The command formats generated output so regeneration is reproducible, and CI checks that it produces no diff.
