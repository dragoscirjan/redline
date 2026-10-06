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
| `REDLINE_MODEL_AUTH` | review mode | Provider-keyed credential map JSON (below). |
| `REDLINE_FINDING_SCOPE` | optional | `defects` (default) or `defects-and-risks`. |
| `REDLINE_TIMEOUT` | optional | Duration like `10m`, `2h`, `1h30m`. Default `30m`, capped at `360m`. |

Rules enforced by the parser:

- Review inputs must arrive together. A partial selection fails instead of degrading to context-only mode.
- Unknown `REDLINE_*` variables are rejected, so typos fail loudly.
- Optional values are validated even without review execution.
- No variable accepts free-form review instructions.

## Model configuration

`REDLINE_MODEL_CONFIG` is provider-neutral JSON with exactly three fields:

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

There is no fixed-model allowlist and no provider-specific credential input.

## Credential map

`REDLINE_MODEL_AUTH` maps provider names to credential values:

```json
{
  "openrouter": "sk-or-v1-…"
}
```

Only the entry for the configured provider is selected; everything else stays host-side. The selected credential reaches the harness through the mechanism documented in [harness executor](/harness-executor) — an environment variable for Pi, a mode-0600 generated config file for OpenCode — and never appears in prompts, logs, diagnostics, or published output.

## CLI usage

The same contract drives the standalone CLI:

```bash
node dist/src/review/cli.js --validate-only   # validate the environment only
node dist/src/review/cli.js                   # run the review
```

Exit codes: `0` success (context-only or completed review), `1` review or bundle failure, `2` usage or validation failure. A review run exits `1` when no reviewed file produced a validated review — every file failed, timed out, or produced invalid output.
