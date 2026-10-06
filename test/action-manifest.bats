#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  ACTION="$ROOT/github/action.yaml"
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
    'timeout', 'artifact-name', 'artifact-retention-days', 'github-token',
}, f'unexpected input surface: {sorted(inputs)}'
assert inputs['finding-scope']['default'] == 'defects'
assert inputs['timeout']['default'] == '30m'
assert inputs['github-token']['default'] == ''
assert inputs['github-token']['required'] is False
runs = action['runs']
assert runs['using'] == 'composite'
steps = [step.get('name', '') for step in runs['steps']]
for expected in [
    'Validate action inputs',
    'Build trusted TypeScript',
    'Validate action inputs with trusted TypeScript',
    'Fetch pull request commits as data',
    'Build review context bundle',
    'Upload review context artifact',
    'Ensure harness binary',
    'Run harness review',
    'Upload review output artifact',
]:
    assert expected in steps, f'missing step: {expected}'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "action runs the review CLI through the REDLINE environment contract" {
  grep -Fq 'dist/src/review/cli.js --validate-only' "$ACTION"
  grep -Fq 'REDLINE_HARNESS: ${{ inputs.backend }}' "$ACTION"
  grep -Fq 'REDLINE_MODEL_CONFIG: ${{ inputs.model-config }}' "$ACTION"
  grep -Fq 'REDLINE_MODEL_AUTH: ${{ inputs.model-auth }}' "$ACTION"
  grep -Fq 'REDLINE_REVIEW_DIR: ${{ github.workspace }}/review' "$ACTION"
  grep -Fq 'REDLINE_SOURCE_DIR: ${{ github.workspace }}/source-at-head' "$ACTION"
  grep -Fq 'REDLINE_OUTPUT_DIR: ${{ github.workspace }}/reviews' "$ACTION"
}

@test "action keeps the context bundle step and both artifact uploads" {
  grep -Fq 'src/context-bundle.sh' "$ACTION"
  grep -Fq 'name: ${{ inputs.artifact-name }}-context' "$ACTION"
  grep -Fq 'name: ${{ inputs.artifact-name }}-reviews' "$ACTION"
  grep -Fq 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1' "$ACTION"
}

@test "action gates review execution on the full review input set" {
  grep -Fq "if: \${{ inputs.backend != '' && inputs.model-config != '' && inputs.model-auth != '' }}" "$ACTION"
}

@test "action maps the publication environment from the github-token input" {
  grep -Fq 'REDLINE_PUBLISH_TOKEN: ${{ inputs.github-token }}' "$ACTION"
  grep -Fq "REDLINE_REPOSITORY: \${{ inputs.github-token != '' && github.repository || '' }}" "$ACTION"
  grep -Fq "REDLINE_PULL_REQUEST: \${{ inputs.github-token != '' && github.event.pull_request.number || '' }}" "$ACTION"
  grep -Fq "REDLINE_HEAD: \${{ inputs.github-token != '' && github.event.pull_request.head.sha || '' }}" "$ACTION"
}

@test "action keeps container and legacy inputs out of the surface" {
  ! grep -Eq 'credential-isolation|container-engine|report-style' "$ACTION"
}

@test "action builds trusted TypeScript from the action checkout" {
  grep -Fq 'pnpm install --frozen-lockfile --ignore-scripts' "$ACTION"
  grep -Fq 'pnpm run build' "$ACTION"
  grep -Fq 'test -f dist/src/review/cli.js' "$ACTION"
}
