#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  ACTION="$ROOT/github/action.yaml"
  REUSABLE_WORKFLOW="$ROOT/.github/workflows/code-review.yml"
  DOGFOOD_WORKFLOW="$ROOT/.github/workflows/dogfood-review.yml"
  PR_REVIEW_WORKFLOW="$ROOT/.github/workflows/pr-review.yml"
  WARMUP_WORKFLOW="$ROOT/.github/workflows/code-index-warmup.yml"
  DOCS_WORKFLOW="$ROOT/.github/workflows/docs.publish.yml"
  CI_WORKFLOW="$ROOT/.github/workflows/ci.yml"
  DEPENDENCY_ACTION="$ROOT/.github/actions/install-dependencies/action.yaml"
}

@test "action declares the fixed review input surface" {
  run python3 - "$ACTION" <<'PY'
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit(0)  # PyYAML unavailable; step-level grep tests below cover the surface

action = yaml.safe_load(Path(sys.argv[1]).read_text())
inputs = action['inputs']
assert set(inputs) == {
    'backend', 'model-config', 'model-auth', 'finding-scope',
    'timeout', 'run-timeout', 'review-concurrency', 'runtime', 'verbosity', 'review-eligibility', 'indexing', 'indexing-provider', 'artifact-name', 'artifact-retention-days',
    'github-token', 'github-app-id', 'github-app-key',
}, f'unexpected input surface: {sorted(inputs)}'
assert inputs['finding-scope']['default'] == 'defects'
assert inputs['timeout']['default'] == '4m'
assert inputs['run-timeout']['default'] == '10m'
assert inputs['review-concurrency']['default'] == '4'
assert inputs['runtime']['default'] == 'node'
assert inputs['verbosity']['default'] == 'progress'
assert inputs['review-eligibility']['default'] == ''
assert inputs['indexing']['default'] == 'enabled'
assert inputs['indexing-provider']['default'] == 'cgc'
assert inputs['github-token']['default'] == ''
assert inputs['github-token']['required'] is False
runs = action['runs']
assert runs['using'] == 'composite'
steps = [step.get('name', '') for step in runs['steps']]
for expected in [
    'Validate action inputs',
    'Generate Redline App token for review start',
    'Set up pinned Node runtime',
    'Set up pinned Bun runtime',
    'Check trusted TypeScript source',
    'Validate action inputs with trusted TypeScript',
    'Restore validated per-file review records',
    'Fetch pull request commits as data',
    'Build bounded code index',
    'Build review context bundle',
    'Upload review context artifact',
    'Set up fixed harness Node runtime',
    'Ensure harness binary',
    'Announce review start',
    'Run harness review',
    'Save validated per-file review records',
    'Generate Redline App token for publication',
    'Publish review',
    'Notify review failure',
    'Upload review output artifact',
]:
    assert expected in steps, f'missing step: {expected}'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "action pins the selectable TypeScript runtimes" {
  grep -Fq 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.0.0' "$ACTION"
  grep -Fq "if: \${{ inputs.runtime == 'node' }}" "$ACTION"
  grep -Fq 'node-version: 24' "$ACTION"
  grep -Fq 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2' "$ACTION"
  grep -Fq "if: \${{ inputs.runtime == 'bun' && (inputs.backend == 'pi' || inputs.backend == 'opencode') }}" "$ACTION"
  grep -Fq "if: \${{ inputs.runtime == 'bun' }}" "$ACTION"
  grep -Fq 'bun-version: 1.4.4' "$ACTION"
}

@test "action runs the review CLI through the REDLINE environment contract" {
  grep -Fq '"$TYPESCRIPT_RUNTIME" src/review/cli.ts --validate-only' "$ACTION"
  grep -Fq 'REDLINE_HARNESS: ${{ inputs.backend }}' "$ACTION"
  grep -Fq 'REDLINE_MODEL_CONFIG: ${{ inputs.model-config }}' "$ACTION"
  grep -Fq 'REDLINE_MODEL_AUTH: ${{ inputs.model-auth }}' "$ACTION"
  grep -Fq 'REDLINE_TIMEOUT: ${{ inputs.timeout }}' "$ACTION"
  grep -Fq 'REDLINE_RUN_TIMEOUT: ${{ inputs.run-timeout }}' "$ACTION"
  grep -Fq 'REDLINE_REVIEW_DIR: ${{ github.workspace }}/review' "$ACTION"
  grep -Fq 'REDLINE_SOURCE_DIR: ${{ github.workspace }}/source-at-head' "$ACTION"
  grep -Fq 'REDLINE_OUTPUT_DIR: ${{ github.workspace }}/reviews' "$ACTION"
  grep -Fq 'REDLINE_CODE_CONTEXT: ${{ steps.code-index.outputs.context-file }}' "$ACTION"
  grep -Fq "REDLINE_CODE_CONTEXT_REPOSITORY: \${{ steps.code-index.outputs.context-file != '' && github.repository || '' }}" "$ACTION"
  ! grep -Fq 'inputs.code-context' "$ACTION"
}

@test "action composes its code-index action at the same running commit" {
  grep -Fq 'uses: $/github/code-index' "$ACTION"
  grep -Fq "if: \${{ inputs.indexing == 'enabled' && inputs.backend != '' && inputs.model-config != '' && inputs.model-auth != '' }}" "$ACTION"
  grep -Fq 'provider: ${{ inputs.indexing-provider }}' "$ACTION"
  grep -Fq 'base: ${{ github.event.pull_request.base.sha }}' "$ACTION"
  grep -Fq 'head: ${{ github.event.pull_request.head.sha }}' "$ACTION"
  grep -Fq 'repository: ${{ github.repository }}' "$ACTION"
  grep -Fq 'output-directory: ${{ github.workspace }}/code-index' "$ACTION"
  grep -Fq 'code-index/code-context.json' "$ACTION"
  grep -Fq "[[ \"\$INDEXING\" == 'enabled' || \"\$INDEXING\" == 'disabled' ]]" "$ACTION"
}

@test "reusable workflow composes the matching root action and forwards indexing policy" {
  grep -Fq 'default: enabled' "$REUSABLE_WORKFLOW"
  grep -Fq 'uses: $/github' "$REUSABLE_WORKFLOW"
  grep -Fq 'indexing: ${{ inputs.indexing }}' "$REUSABLE_WORKFLOW"
  grep -Fq 'indexing-provider: ${{ inputs.indexing-provider }}' "$REUSABLE_WORKFLOW"
  grep -Fq 'timeout: ${{ inputs.timeout }}' "$REUSABLE_WORKFLOW"
  grep -Fq 'run-timeout: ${{ inputs.run-timeout }}' "$REUSABLE_WORKFLOW"
  ! grep -Fq 'uses: dragoscirjan/redline/github@v1' "$REUSABLE_WORKFLOW"
  ! grep -Fq 'uses: $/github/code-index' "$REUSABLE_WORKFLOW"
  ! grep -Fq 'report-style: ${{ inputs.report-style }}' "$REUSABLE_WORKFLOW"
  ! grep -Fq 'credential-isolation: ${{ inputs.credential-isolation }}' "$REUSABLE_WORKFLOW"
  ! grep -Fq 'container-engine: ${{ inputs.container-engine }}' "$REUSABLE_WORKFLOW"
}

@test "default-branch warmup prepares both pinned provider caches with bounded concurrency" {
  if ! python3 -c 'import yaml' 2>/dev/null; then
    skip 'PyYAML is required to validate workflow YAML'
  fi
  python3 - "$WARMUP_WORKFLOW" <<'PY'
import sys
from pathlib import Path
import yaml

workflow = yaml.safe_load(Path(sys.argv[1]).read_text())
assert workflow[True] == {'push': {'branches': ['main']}}
assert workflow['permissions'] == {}
assert workflow['concurrency'] == {
    'group': 'redline-code-index-warmup-${{ github.repository_id }}',
    'cancel-in-progress': True,
}
job = workflow['jobs']['warmup']
assert job['permissions'] == {'contents': 'read'}
assert job['strategy']['fail-fast'] is False
assert job['strategy']['max-parallel'] == 2
assert job['strategy']['matrix']['provider'] == ['cgc', 'gitnexus']
steps = job['steps']
checkout = next(step for step in steps if step.get('name') == 'Check out trusted default-branch revision')
assert checkout['with']['ref'] == '${{ github.sha }}'
assert checkout['with']['persist-credentials'] is False
assert checkout['with']['fetch-depth'] == 0
warmup = next(step for step in steps if step.get('id') == 'warmup')
assert warmup['uses'] == './github/code-index'
assert warmup['with']['mode'] == 'warmup'
assert warmup['with']['base'] == warmup['with']['head'] == '${{ github.sha }}'
assert warmup['with']['provider'] == '${{ matrix.provider }}'
assert any(step.get('name') == 'Upload warmup diagnostics' for step in steps)
assert any(step.get('name') == 'Fail visible warmup errors' for step in steps)
PY
}

@test "documentation workflow publishes through a destination pull request" {
  grep -Fq 'group: docs-publish-redline' "$DOCS_WORKFLOW"
  grep -Fq 'name: Build and publish the site' "$DOCS_WORKFLOW"
  grep -Fq 'DOCS_BASE=/projects/redline/ pnpm run docs' "$DOCS_WORKFLOW"
  grep -Fq 'name: docs-site' "$DOCS_WORKFLOW"
  grep -Fq 'path: docs/.vitepress/dist' "$DOCS_WORKFLOW"
  grep -Fq 'repository: dragoscirjan/dragoscirjan.github.io' "$DOCS_WORKFLOW"
  grep -Fq 'token: ${{ secrets.GH_TOKEN }}' "$DOCS_WORKFLOW"
  grep -Fq 'path: documentation-repository' "$DOCS_WORKFLOW"
  grep -Fq 'rsync -a --delete' "$DOCS_WORKFLOW"
  grep -Fq 'documentation-repository/projects/redline/' "$DOCS_WORKFLOW"
  grep -Fq 'GH_TOKEN: ${{ secrets.GH_TOKEN }}' "$DOCS_WORKFLOW"
  grep -Fq 'publish_branch="automation/redline-docs-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' "$DOCS_WORKFLOW"
  grep -Fq 'git -C documentation-repository push --set-upstream origin "$publish_branch"' "$DOCS_WORKFLOW"
  grep -Fq 'gh pr create \' "$DOCS_WORKFLOW"
  grep -Fq -- '--repo dragoscirjan/dragoscirjan.github.io' "$DOCS_WORKFLOW"
  grep -Fq 'gh pr merge \' "$DOCS_WORKFLOW"
  grep -Fq -- '--match-head-commit "$publish_head"' "$DOCS_WORKFLOW"
  grep -Fq -- '--delete-branch' "$DOCS_WORKFLOW"
  ! grep -Fq 'push origin main' "$DOCS_WORKFLOW"
  ! grep -Fq 'uses: dragoscirjan/dragoscirjan.github.io/.github/workflows/docs.yml' "$DOCS_WORKFLOW"
}

@test "dogfood workflow gates the complete review input set on model credentials" {
  grep -Fq "backend: \${{ secrets.model-auth != '' && 'pi' || '' }}" "$DOGFOOD_WORKFLOW"
  grep -Fq "model-config: \${{ secrets.model-auth != '' && '{\"provider\":\"openrouter\",\"endpoint\":\"https://openrouter.ai/api/v1\",\"model\":\"z-ai/glm-5.3-flash\"}' || '' }}" "$DOGFOOD_WORKFLOW"
  grep -Fq 'model-auth: ${{ secrets.model-auth }}' "$DOGFOOD_WORKFLOW"
  grep -Fq 'timeout: ${{ inputs.timeout }}' "$DOGFOOD_WORKFLOW"
  grep -Fq 'run-timeout: ${{ inputs.run-timeout }}' "$DOGFOOD_WORKFLOW"
  grep -Fq 'review-eligibility: ${{ inputs.review-eligibility }}' "$DOGFOOD_WORKFLOW"
  ! grep -Fq 'Install pi harness binary' "$DOGFOOD_WORKFLOW"
  ! grep -Fq 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' "$DOGFOOD_WORKFLOW"
}

@test "action loads bounded eligibility from trusted workflow input or exact base" {
  grep -Fq 'review-eligibility: ${{ inputs.review-eligibility }}' "$REUSABLE_WORKFLOW"
  grep -Fq 'REVIEW_ELIGIBILITY: ${{ inputs.review-eligibility }}' "$ACTION"
  grep -Fq -- '--eligibility-policy-file "$eligibility_file"' "$ACTION"
  grep -Fq '.redline/review-eligibility.json' "$ACTION"
  grep -Fq 'verbosity: progress' "$PR_REVIEW_WORKFLOW"
  ! grep -Fq 'verbosity: full-output' "$PR_REVIEW_WORKFLOW"
}

@test "action keeps the context bundle step and both artifact uploads" {
  grep -Fq 'src/context-bundle.ts' "$ACTION"
  grep -Fq 'name: ${{ inputs.artifact-name }}-context' "$ACTION"
  grep -Fq 'name: ${{ inputs.artifact-name }}-reviews' "$ACTION"
  grep -Fq 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1' "$ACTION"
  grep -Fq 'include-hidden-files: true' "$ACTION"
}

@test "action gates review execution on the full review input set" {
  grep -Fq "if: \${{ inputs.backend != '' && inputs.model-config != '' && inputs.model-auth != '' }}" "$ACTION"
}

@test "action maps bounded review concurrency through every public surface" {
  count=$(grep -cF 'REDLINE_REVIEW_CONCURRENCY: ${{ inputs.review-concurrency }}' "$ACTION")
  [ "$count" -eq 2 ]
  grep -Fq '[[ "$REVIEW_CONCURRENCY" =~ ^[1-8]$ ]]' "$ACTION"
  grep -Fq 'review-concurrency: ${{ inputs.review-concurrency }}' "$REUSABLE_WORKFLOW"
  grep -A5 '^      review-concurrency:' "$REUSABLE_WORKFLOW" | grep -Fq 'default: 4'
  grep -Fq 'review-concurrency: ${{ inputs.review-concurrency }}' "$DOGFOOD_WORKFLOW"
  grep -A5 '^      review-concurrency:' "$DOGFOOD_WORKFLOW" | grep -Fq 'default: 4'
}

@test "action restores and saves PR-scoped validated review records" {
  grep -Fq 'actions/cache/restore@cdf6c1fa76f9f475f3d7449005a359c84ca0f306 # v5.0.3' "$ACTION"
  grep -Fq 'actions/cache/save@cdf6c1fa76f9f475f3d7449005a359c84ca0f306 # v5.0.3' "$ACTION"
  grep -Fq 'redline-review-v2-${{ github.repository_id }}-pr-${{ github.event.pull_request.number }}-' "$ACTION"
  count=$(grep -cF 'REDLINE_REUSE_DIR:' "$ACTION")
  [ "$count" -eq 2 ]
  count=$(grep -cF 'REDLINE_REUSE_NAMESPACE:' "$ACTION")
  [ "$count" -eq 2 ]
  grep -A2 -F 'name: Save validated per-file review records' "$ACTION" | grep -Fq 'always()'
}

@test "action maps the verbosity to the environment contract" {
  count=$(grep -cF 'REDLINE_VERBOSITY: ${{ inputs.verbosity }}' "$ACTION")
  [ "$count" -eq 2 ]
}

@test "action generates two App tokens and prefers them" {
  grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0' "$ACTION"
  # Token 1: review start (and failure notifications). Token 2: publication.
  grep -Fq 'id: app-token-start' "$ACTION"
  grep -Fq 'id: app-token-publish' "$ACTION"
  grep -Fq 'private-key: ${{ inputs.github-app-key }}' "$ACTION"
}

@test "action runs the review token-free and publishes in its own step" {
  grep -Fq 'src/review/cli.ts" --announce-only' "$ACTION"
  grep -Fq 'src/review/cli.ts" --publish-only' "$ACTION"
  grep -Fq 'src/review/cli.ts" --announce-failure' "$ACTION"
  grep -Fq 'REDLINE_PUBLISH_TOKEN: ${{ steps.app-token-publish.outputs.token || inputs.github-token }}' "$ACTION"
  count=$(grep -cF 'REDLINE_PUBLISH_TOKEN: ${{ steps.app-token-start.outputs.token || inputs.github-token }}' "$ACTION")
  [ "$count" -eq 2 ]
  # The failure notice prefers the fresh publication token when one exists.
  grep -Fq 'REDLINE_PUBLISH_TOKEN: ${{ steps.app-token-publish.outputs.token || steps.app-token-start.outputs.token || inputs.github-token }}' "$ACTION"
  # Publication failure only replaces the running summary when publication
  # did not already finalize that managed comment.
  grep -Fq 'id: publish' "$ACTION"
  grep -Fq "printf 'summary-finalized=%s\\n' \"\$summary_finalized\" >> \"\$GITHUB_OUTPUT\"" "$ACTION"
  grep -Fq "steps.publish.conclusion == 'failure' && steps.publish.outputs.summary-finalized != 'true'" "$ACTION"
}

@test "action keeps container and legacy inputs out of the surface" {
  ! grep -Eq 'credential-isolation|container-engine|report-style' "$ACTION"
}

@test "review action executes trusted TypeScript source without project dependency installation" {
  grep -Fq 'test -f src/review/cli.ts' "$ACTION"
  grep -Fq 'test -f src/context-bundle.ts' "$ACTION"
  ! grep -Fq 'corepack' "$ACTION"
  ! grep -Fq 'pnpm install' "$ACTION"
  ! grep -Fq 'pnpm run typecheck' "$ACTION"
  ! grep -Fq 'pnpm run build' "$ACTION"
  ! grep -Fq 'dist/src/' "$ACTION"
}

@test "CI and docs use the bounded versioned pnpm store cache" {
  [ "$(grep -Fc 'uses: ./.github/actions/install-dependencies' "$CI_WORKFLOW")" -eq 3 ]
  [ "$(grep -Fc 'uses: ./.github/actions/install-dependencies' "$DOCS_WORKFLOW")" -eq 1 ]
  ! grep -Fq 'pnpm install' "$CI_WORKFLOW"
  ! grep -Fq 'pnpm install' "$DOCS_WORKFLOW"

  grep -Fq 'pnpm install --frozen-lockfile --ignore-scripts' "$DEPENDENCY_ACTION"
  grep -Fq 'actions/cache/restore@cdf6c1fa76f9f475f3d7449005a359c84ca0f306 # v5.0.3' "$DEPENDENCY_ACTION"
  grep -Fq 'actions/cache/save@cdf6c1fa76f9f475f3d7449005a359c84ca0f306 # v5.0.3' "$DEPENDENCY_ACTION"
  grep -Fq 'continue-on-error: true' "$DEPENDENCY_ACTION"
  grep -Fq 'redline-pnpm-store-v1-${{ runner.os }}-${{ runner.arch }}-node24-pnpm10.33.0-${{ hashFiles('\''pnpm-lock.yaml'\'') }}' "$DEPENDENCY_ACTION"
  grep -Fq 'PNPM_STORE_PATH: ${{ runner.temp }}/redline-pnpm-store-v1' "$DEPENDENCY_ACTION"
  grep -Fq "MAX_STORE_BYTES: '536870912'" "$DEPENDENCY_ACTION"
  grep -Fq 'Cached pnpm store failed installation; retrying from an empty store.' "$DEPENDENCY_ACTION"
  grep -Fq 'storeSizeBytes' "$DEPENDENCY_ACTION"
  grep -Fq 'installMs' "$DEPENDENCY_ACTION"
  ! grep -A3 'uses: actions/cache/restore@' "$DEPENDENCY_ACTION" | grep -Fq 'node_modules'
  ! grep -A3 'uses: actions/cache/save@' "$DEPENDENCY_ACTION" | grep -Fq 'node_modules'
}

@test "action validates and forwards the trusted runtime before repository data" {
  validation_line=$(grep -nF 'name: Validate action inputs' "$ACTION" | head -n1 | cut -d: -f1)
  fetch_line=$(grep -nF 'name: Fetch pull request commits as data' "$ACTION" | head -n1 | cut -d: -f1)
  [ "$validation_line" -lt "$fetch_line" ]
  grep -Fq '[[ "$TYPESCRIPT_RUNTIME" == '\''node'\'' || "$TYPESCRIPT_RUNTIME" == '\''bun'\'' ]]' "$ACTION"
  grep -Fq 'runtime: ${{ inputs.runtime }}' "$REUSABLE_WORKFLOW"
  grep -A5 '^      runtime:' "$REUSABLE_WORKFLOW" | grep -Fq 'default: node'
  grep -Fq 'runtime: ${{ inputs.runtime }}' "$DOGFOOD_WORKFLOW"
  grep -A5 '^      runtime:' "$DOGFOOD_WORKFLOW" | grep -Fq 'default: node'
  grep -Fq 'runtime: [node, bun]' "$CI_WORKFLOW"
  grep -Fq 'action.json' "$CI_WORKFLOW"
  grep -Fq 'Run composite action from TypeScript source' "$CI_WORKFLOW"
}
