# Indexing and provider licenses

Code indexing and queries belong to the LLM through the selected harness's available tools. Redline captures source, validates evidence, and reports coverage. The host-managed indexing Action and default-branch index-cache warmup are retired.

## Native CLI and Docker

Keep provider choice explicit because code indexers have different licenses:

```sh
redline review --indexing enabled --indexing-provider cgc
redline review --indexing enabled --indexing-provider gitnexus
redline review --indexing disabled
```

CGC is the default requested provider. GitNexus uses PolyForm Noncommercial 1.0.0; check its suitability before selecting it. Redline does not silently substitute another provider. Installed tools and their permissions remain harness configuration.

The model must use the selected provider's available tools to index captured head source or verify a reusable exact-head index, then run a relevant query. Tool availability, observed calls, index readiness, and coverage limitations remain separate. Missing optional tools allow a reported file-only fallback; `--indexing required` requires verified readiness. See [native model warmup](/local-cli#native-model-warmup).

## GitHub Actions

The current isolated Action does not expose graph-index creation tools to the LLM. Its server and authorization policy remain unchanged. Removing host-managed preparation therefore leaves Actions with file-only coverage until a separate harness migration.

The public `indexing` and `indexing-provider` inputs remain accepted. When a configured review requests indexing, the Action emits a warning and a step summary stating that the requested provider is not invoked. It never selects an alternative provider. No provider installation, graph build, provider-cache restore/save, or background index warmup runs through the retired pipeline.

The context artifact still contains the authoritative review bundle and captured head source. Publication credentials remain outside review execution. Finding schema, exact-diff evidence validation, and publication rules are unchanged.

## Imported context

`--code-context` remains a data-import option for local reviews. It does not invoke an indexer or Python. Redline validates the repository namespace, captured revisions, artifact schema, paths, span bounds, and source content before using related context. Invalid imports report unavailable coverage; required mode stops before review if any reviewed file lacks usable context. Native warmup remains a separate step and still requires verified readiness in required mode.

The provider-neutral artifact contracts and source validation remain under `src/code-context/` and `src/review/indexed-context.ts`. Retiring the producer does not make imported graph relationships authoritative. See [local indexing and imports](/local-cli).
