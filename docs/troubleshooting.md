# Troubleshooting

Start with the error printed by Redline and the `status.json` in the reported artifact directory. Do not post API keys, private configuration files, or unredacted logs when asking for help.

## The command is not found

Check the prerequisites:

```sh
node --version
git --version
```

Use Node.js 24. If Redline is installed, run `redline --help`. Otherwise use `node bin/redline.mjs --help` from its source checkout. When you are in another repository, use the source binary's full path or `--repository`; do not assume `bin/redline.mjs` exists in the project being reviewed.

If npm installation returns `E404`, the requested package/version may not be published or accessible. Use the [source-checkout instructions](/get-started/#use-a-source-checkout). A package-publishing token is not needed to review source.

## No files were reviewed

Inspect the target:

```sh
git status --short
git diff --stat
git diff --cached --stat
```

The default command reviews uncommitted tracked changes. A clean working tree with commits ahead of main needs a [branch comparison](/commands#review-your-branch-against-main). New untracked files need explicit inclusion. Lock files, generated/vendor paths and binary files can be excluded by review eligibility rules.

A repository must have a committed `HEAD`. Resolve merge conflicts and stage or materialize unsupported index states before trying again. See [working-tree behavior](/local-cli#review-uncommitted-changes).

## The model rejects the request

Check these without printing the credential:

1. The selected Pi or OpenCode binary is installed outside the reviewed repository.
2. The user configuration is outside the repository and has private permissions.
3. The credential-map key matches `model-config.provider`.
4. The endpoint includes the correct API path and the model ID is available there.
5. The chosen protocol and token allowance are supported by that provider/model.

HTTP `401` or `403` can indicate credential or access problems. An immediate configuration error is not a timeout; giving it more time will not fix it. Follow the provider's actual error rather than guessing which setting failed.

Redline preserves provider/model reasoning defaults. Do not disable reasoning to work around a structured-output or budget problem. Use [model configuration](/get-started/configuration) and the [request-protocol reference](/local-cli#model-request-protocol).

## An indexer or related context is unavailable

To run without an external indexer:

```sh
redline review --indexing disabled
```

For indexed context, install the supported provider and Python helper separately on the trusted host. Redline does not install them for you. Unsupported versions are not silently replaced. See [supported versions and context modes](/local-cli#indexed-cross-file-context).

`--indexing required` intentionally stops before model review when usable provider context is missing. Documentation and newly added files can lack a base-graph anchor. Do not interpret partial context as an exhaustive dependency search.

## The review did not finish

Read the per-file reasons and run status before changing budgets.

- A whole-run deadline can justify a larger `--run-timeout` or a smaller change.
- A per-file timeout can receive a longer retry attempt within the same run budget.
- Authentication, unsupported requests and output-token exhaustion need their own correction; they are not fixed by blindly retrying.

Repeat the same review command to reuse eligible validated results from completed files. Failed or incomplete records are not reused as successful reviews. See [retries and deadlines](/local-cli#review-retries-and-timeouts) and [result reuse](/local-cli#resume-validated-work).

## The output path is rejected

Choose a new directory outside the reviewed repository with an existing parent. From the repository root:

```sh
redline review --output ../redline-review-001
```

If that directory already exists, choose another name. Redline does not overwrite an earlier run.

## The command exited zero but findings are present

Findings do not fail the command by default. Use `--fail-on findings`, `--fail-on high`, or `--fail-on critical` when you want a nonzero finding-policy result. Incomplete coverage still fails independently.

Read [results and exit codes](/results) before treating exit code `0` as proof that the change is defect-free.
