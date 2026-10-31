# Connect a model

A real review needs Pi or OpenCode plus a model endpoint. Redline does not install either harness or a local model server for you.

## 1. Install one harness

Skip installation if your chosen harness is already on a trusted PATH outside the repository you will review.

### Pi

```sh
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

### OpenCode

```sh
npm install --global opencode-ai@1.18.34
opencode --version
```

OpenCode's installer links its platform binary, so that installation needs its install script. `1.18.34` is the version used by Redline's CI protocol tests. This is separate from the Redline package, which has no install script or runtime dependencies.

## 2. Create your private user configuration

Use `$XDG_CONFIG_HOME/redline/config.json` when `XDG_CONFIG_HOME` is set. Otherwise use `$HOME/.config/redline/config.json`. `$HOME` is your user home directory on Linux, macOS, and Windows.

Keep this file outside every repository you review. It must be a regular file, not a symlink. If it already exists, edit it rather than replacing settings you need.

On Linux and macOS, create the file and restrict it to your account before adding a key. For the default location:

```sh
mkdir -p "$HOME/.config/redline"
touch "$HOME/.config/redline/config.json"
chmod 600 "$HOME/.config/redline/config.json"
```

Use your actual XDG configuration path if it differs. On Windows, keep the file in your user profile and restrict access to your account. Never commit it or pass credentials as command-line arguments. `NPM_TOKEN` is a package-publishing credential, not a model API key.

This example uses OpenRouter. Replace `YOUR_MODEL_ID` with an available model ID and `YOUR_API_KEY` with its credential:

```json
{
  "harness": "pi",
  "model-config": {
    "provider": "openrouter",
    "endpoint": "https://openrouter.ai/api/v1",
    "model": "YOUR_MODEL_ID"
  },
  "model-auth": {
    "openrouter": "YOUR_API_KEY"
  }
}
```

For OpenCode, change `harness` to `opencode`. The credential-map key must match `model-config.provider`. The endpoint must include the provider's compatible API path, such as `/v1`.

## 3. Run a model-based review

This sends captured source to your selected provider and can incur model charges. It uses your private configuration and does not execute the reviewed code.

Run it from a repository with tracked changes:

```sh
redline review --indexing disabled
```

Indexing is disabled here to keep the first model run independent of external indexer setup. Later, use `redline review` to attempt the default indexed context. Missing or partial context is reported; it is not proof that related code does not exist.

## Use a local compatible endpoint

The model server must already be running. If it needs no credential, use `auth: "none"` and omit `model-auth`:

```json
{
  "harness": "pi",
  "model-config": {
    "provider": "local",
    "endpoint": "http://127.0.0.1:1234/v1",
    "model": "YOUR_LOCAL_MODEL_ID",
    "auth": "none"
  }
}
```

The model ID must match the server's model. Redline does not start or download the model.

## Change settings for one run

Non-secret flags override environment settings, which override the user file. For example:

```sh
redline review --run-timeout 20m --concurrency 4
redline review --config /path/to/private-config.json
```

Scalar settings in the user file use strings, such as `"run-timeout": "20m"`. Both harnesses preserve provider/model reasoning defaults. See the [configuration reference](/local-cli#configuration) for the complete contract and [troubleshooting](/troubleshooting#the-model-rejects-the-request) for request failures.
