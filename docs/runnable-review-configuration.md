# First runnable review configuration

Issue #19 defines the configuration accepted by the first runnable Redline review. The contract lives in `src/review-configuration.ts`. It is host-side code. The review prompt, journal, publication service, and backend container do not receive the full input or credential map.

## Host integration

The host uses the module before it prepares a backend container:

```ts
const configuration = parseFirstRunnableReviewConfiguration({
  backend,
  modelConfig,
  credentialIsolation,
  findingScope,
  reportStyle,
});
const credential = selectDirectModelCredential(configuration, modelCredentials);
```

The later container-staging work uses `configuration.model` to generate the minimum native Pi or OpenCode settings. It receives only `credential`, which contains the configured provider name and its selected value. The host must discard the original `modelCredentials` string after selection.

Do not log either credential input or the selected value. Do not put them in prompts, journals, diagnostics, artifacts, or forge comments.

## Model configuration

`model-config` is an exact JSON object:

```json
{
  "provider": "openrouter",
  "endpoint": "https://openrouter.ai/api/v1",
  "model": "provider/model-name"
}
```

All three fields are required. The parser rejects unknown fields, malformed JSON, empty values, control characters, oversized input, and invalid provider names.

`endpoint` must be an absolute HTTP or HTTPS URL. Private and loopback HTTP endpoints are allowed because this profile supports existing private model services. The parser rejects URL credentials, fragments, local file URLs, and other schemes. It checks syntax only. It does not contact the endpoint, authorize the destination, resolve DNS, or start a model server.

The fixed shape prevents callers from supplying native Pi or OpenCode configuration, headers, commands, executable paths, server arguments, or file references.

## Credential selection

`model-credentials` is a JSON object that maps provider names to credential strings:

```json
{
  "openrouter": "credential-used-for-this-run",
  "private-backup": "credential-that-remains-host-side"
}
```

The host selects the own property whose name equals `model-config.provider`. A missing, empty, non-string, control-character-containing, or oversized selected value fails validation. Extra entries are allowed so one secret can hold credentials for more than one provider. The selector returns only the matching entry.

The selected string is the bearer token or API key expected by the configured provider. The configuration does not accept arbitrary header names. The [container staging layer](container-staging.md) sends only the selected value through its private bootstrap channel. Generated native configuration refers to a fixed environment variable and does not contain the credential.

## Fixed review profile

The first profile accepts these values:

| Setting | Accepted value |
| --- | --- |
| `backend` | `pi` or `opencode` |
| `finding-scope` | `defects`, which is also the default |
| `report-style` | `single-block` by default, or `inline` |
| `credential-isolation` | Explicit `direct` only |

The executable controller fixes these capabilities off:

- Subagents
- Vulnerability lookup
- Managed model-runtime lifecycle

Both backends use the same review controller and structured event validation. `inline` changes publication only. It does not let the backend publish findings directly.

## Direct credential isolation

`direct` is a legacy escape hatch. It has no default. The caller must opt in with `credential-isolation: direct`.

In direct mode, the container staging launcher sends the selected provider credential to the fixed image bootstrap through stdin. It does not place the value in container arguments, Docker or Podman environment options, copied files, or generated configuration. Unused credentials stay in trusted host memory. This mode does not provide destination pinning or the planned host-side credential gateway. Use it only when the caller trusts the configured endpoint and the network path to it.

## Delivery boundary

Issue #19 adds validation and credential selection. Issue #20 adds read-only container preparation, tmpfs configuration, and data staging without host mounts. Neither issue changes the GitHub Action inputs.

- Issue #21 owns GitHub Action inputs and calls this parser before it constructs the container-staging launcher.
- Issue #22 owns the reusable workflow used by other repositories.
- Issue #23 owns immutable runner-image selection.

Until #21 lands, the existing action still builds and uploads the review context but does not invoke Pi or OpenCode.
