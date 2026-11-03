# Connect a model

Choose Pi or OpenCode, then tell Redline which provider and model to use. This setup is for the local CLI. GitHub Actions uses a [repository secret instead](/get-started/github-actions).

## Install one harness {#_1-install-one-harness}

Skip installation if your chosen version is already on a trusted PATH outside the repository you will review. These are the versions used by the bundled Docker image.

### Pi

```sh
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
pi --version
```

### OpenCode

```sh
npm install --global opencode-ai@1.18.34
opencode --version
```

OpenCode needs its install script to link the platform binary. Redline's own npm package does not need an install script. For an environment with both harnesses already installed, use [Docker](/docker-workers).

## Add your private configuration {#_2-create-your-private-user-configuration}

Create a regular file outside every repository you review:

- `$XDG_CONFIG_HOME/redline/config.json` if `XDG_CONFIG_HOME` is set.
- Otherwise, `$HOME/.config/redline/config.json`.

`$HOME` is your user home directory on Linux, macOS and Windows. If the file already exists, edit it rather than replacing settings you need. Do not use a symlink or commit this file.

On Linux and macOS, create the default location and restrict access before adding a key:

```sh
mkdir -p "$HOME/.config/redline"
touch "$HOME/.config/redline/config.json"
chmod 600 "$HOME/.config/redline/config.json"
```

Use your XDG configuration path if it differs. On Windows, create the file in your user profile and restrict access to your account.

This example uses OpenRouter. Replace `YOUR_MODEL_ID` with an available model ID and `YOUR_API_KEY` with its model-provider credential:

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

For OpenCode, change `harness` to `opencode`. The credential-map key must match `model-config.provider`. Keep credentials in this private file or your secret mechanism, never in command-line arguments.

Redline uses its own generated harness configuration rather than your personal Pi/OpenCode login, plugins or MCP settings.

## Run a review {#_3-run-a-model-based-review}

From a Git repository with tracked changes:

```sh
redline review --indexing disabled
```

This sends captured source to your selected provider and can incur model charges. Continue with [your first review](/get-started/first-review) or [read the results](/results).

## Use a local compatible endpoint

Start your model server separately. If it needs no credential, set `auth` to `none` and omit `model-auth`:

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

Use the model ID and compatible API endpoint exposed by your server, including its API path such as `/v1`. Redline does not download or start models.

## Change settings for one run

```sh
redline review --run-timeout 20m --concurrency 4
redline review --config /path/to/private-config.json
```

Non-secret flags override environment settings, which override the user file. Both harnesses preserve provider/model reasoning defaults. See the [configuration reference](/local-cli#configuration) for all settings, [related-code context](/local-cli#indexed-cross-file-context) for optional indexing, or [troubleshooting](/troubleshooting#the-model-rejects-the-request) for request failures.
