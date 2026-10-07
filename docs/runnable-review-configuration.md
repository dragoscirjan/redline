# Runnable review configuration

The GitHub Action passes every value to the review tool through environment variables. This is the interim contract; the parsing in `src/review/environment.ts` is authoritative.

## Environment contract

| Variable | Required | Meaning |
| --- | --- | --- |
| `REDLINE_HARNESS` | review mode | `echo`, `pi`, or `opencode`. |
| `REDLINE_REVIEW_DIR` | review mode | Directory holding the context bundle (`manifest.json`, `diffs/`, `base-files/`, …). |
| `REDLINE_SOURCE_DIR` | review mode | Source-at-head export used for head-file context. |
| `REDLINE_OUTPUT_DIR` | review mode | Destination for per-file review records and the summary. |
| `REDLINE_MODEL_CONFIG` | review mode | Model configuration JSON (below). |
| `REDLINE_MODEL_AUTH` | review mode | Provider-keyed credential map JSON (below). Not consulted when the model config declares `auth: "none"`. |
| `REDLINE_FINDING_SCOPE` | optional | `defects` (default) or `defects-and-risks`. |
| `REDLINE_TIMEOUT` | optional | Duration like `10m`, `2h`, `1h30m`. Default `30m`, capped at `360m`. |
| `REDLINE_VERBOSITY` | optional | `silent` (per-file lines only), `progress` (one dot per model text chunk, default), or `full-output` (readable stream text). |

Rules enforced by the parser:

- Review inputs must arrive together. A partial selection fails instead of degrading to context-only mode.
- Unknown `REDLINE_*` variables are rejected, so typos fail loudly.
- Optional values are validated even without review execution.
- No variable accepts free-form review instructions.

## Model configuration

`REDLINE_MODEL_CONFIG` is provider-neutral JSON with three required fields plus one optional auth field:

```json
{
  "provider": "openrouter",
  "endpoint": "https://openrouter.ai/api/v1",
  "model": "z-ai/glm-5.3-flash"
}
```

- `provider` — a short identifier, `[A-Za-z0-9._-]`, at most 64 characters. It keys the credential map and names the provider inside harness configuration.
- `endpoint` — absolute `http` or `https` URL of an OpenAI-compatible API. Loopback endpoints are permitted for local model servers and the CI mock endpoint.
- `model` — the model identifier understood by the endpoint, at most 256 characters.
- `auth` — optional; the only supported value is `"none"`, the credential-less profile for endpoints that need no authentication. See [local model runners](#local-model-runners).

There is no fixed-model allowlist and no provider-specific credential input.

## Credential map

`REDLINE_MODEL_AUTH` maps provider names to credential values:

```json
{
  "openrouter": "sk-or-v1-…"
}
```

Only the entry for the configured provider is selected; everything else stays host-side. The selected credential reaches the harness through the mechanism documented in [harness executor](/harness-executor) — an environment variable for Pi, a mode-0600 generated config file for OpenCode — and never appears in prompts, logs, diagnostics, or published output.

When the model config declares `"auth": "none"`, the credential map is not required and **not consulted**: no credential is selected and nothing reaches the harness. A supplied map is tolerated (not an error) because the action's review gate requires a non-empty `model-auth`; pass a placeholder map there.

## Local model runners

Local runners that expose an OpenAI-compatible REST endpoint work through the same contract, with the credential-less profile — no paid API key involved:

| Runner | Endpoint | Model id |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | `name:tag`, for example `qwen3:0.6b` |
| LM Studio | `http://127.0.0.1:1234/v1` | model identifier shown in the server tab |
| llama.cpp server | `http://127.0.0.1:8080/v1` | `-m` model name or `-a` alias |
| vLLM | `http://<host>:8000/v1` | served model name |

```bash
REDLINE_MODEL_CONFIG='{"provider":"ollama","endpoint":"http://127.0.0.1:11434/v1","model":"qwen3:0.6b","auth":"none"}'
REDLINE_MODEL_AUTH=''
```

Notes:

- Each runner mounts the OpenAI-compatible API under `/v1` — include the suffix.
- Loopback (`127.0.0.1`, `localhost`) and private-network endpoints are accepted by the same endpoint validation as remote APIs.
- A server that still checks the header (rare) instead takes a placeholder entry in `REDLINE_MODEL_AUTH`; the value is local-only.
- Via the GitHub Action, keep supplying `model-auth` (a placeholder map) — the action's review gate requires it, and with `auth: "none"` the map is not consulted, so no credential reaches the harness.
- Self-hosted CI runners can reach the local server directly, which is the intended production shape for private projects. The container-sandbox milestone will revisit isolation for untrusted environments.

## CLI usage

The same contract drives the standalone CLI:

```bash
node dist/src/review/cli.js --validate-only   # validate the environment only
node dist/src/review/cli.js                   # run the review
```

Exit codes: `0` success (context-only or completed review), `1` review or bundle failure, `2` usage or validation failure. A review run exits `1` when no reviewed file produced a validated review — every file failed, timed out, or produced invalid output.
