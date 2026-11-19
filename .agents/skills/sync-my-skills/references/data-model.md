# Synchronization data contracts

## One authored YAML catalog

[`../assets/skill-catalog.yaml`](../assets/skill-catalog.yaml) is the only authored inventory. The JSON [catalog schema](../assets/skill-catalog.schema.json) supports editor validation; the helper enforces semantic constraints, paths, dependency closure, and safe parsing. No generated JSON catalog or separate external-skills inventory is needed.

YAML uses version 1.2 with unique keys. Multiple documents, aliases, unresolved/custom tags, prototype-sensitive keys, oversized input, and excessive nesting are rejected. This is data, not an arbitrary shell or executable configuration language.

Top-level fields:

- `schemaVersion: 2`.
- `repository`: credential-free HTTPS owner repository on GitHub.
- `ref`: owner revision to resolve for local sources when no complete checkout is supplied. The actual commit is recorded.
- `defaults.exclude`: source-relative exclusion patterns.
- `skills`: mapping from stable skill name to its definition.
- `deprecations`: exact old names, active replacements, and reasons.
- `instructionTemplates`: an explicit `enabled` choice, owner-relative template `path`, fixed guidance `prerequisites`, and optional issue reference. Enabled bundles require `isolated-workspace`, `document-project`, `asd-ste100-technical`, and `unslop`; this does not add them to every skills-only selection.

Each skill has:

| Field | Meaning |
|---|---|
| `kind` | `authored`, `upstream`, or `adapted`; inspiration is not automatically an import. |
| `source` | Local owner-relative directory, including categorized skill paths, or immutable GitHub subtree. The source path is provenance, not the destination layout. |
| `upstream` | Optional original-source provenance for a maintained adaptation. |
| `scope` | Project skill by default; the personal manager is not a compulsory project install. |
| `description`, `category`, `safety` | Human selection/review context. |
| `selection`, `signals` | Initial recommendations and evidence hints, never authorization or a filter that hides remaining entries. `recommended` means always suggest and ask, not install automatically. |
| `prerequisites` | Skill installation closure; no mandatory provider-specific frontmatter is imposed upstream. |
| `capabilities`, `runtime`, `harnesses` | Distinct feature, tool, and destination constraints. |
| `install.argv` | Documented reviewed acquisition mechanism, never automatically executed during inspection. |
| `include`, `exclude` | Glob filters relative to the selected skill subtree. |
| `legal` | Repository-root legal paths copied to explicit skill-relative targets, with license identifiers. |
| `adaptation` | Semantic instructions and review criteria; not a mandatory template or patch engine. |

Inclusion/exclusion patterns support `*`, `**`, and `?`; they are not shell expressions. The supported source backends are `local` and public `github`. Upstream definitions require full 40-character commit IDs. Local paths resolve from a supplied complete Git checkout whose credential-free GitHub origin identity matches the catalog owner; standard SSH and HTTPS forms are recognized. Without a checkout, they resolve from the catalog owner repository/ref. The helper downloads a selected subtree and legal files, not every repository file. It rejects truncated tree responses, selected symlinks, path escapes, missing files, and excessive size. No GitHub credentials are required.

Every `npx` argument array must put `-y` second. Duplicate ordinary arguments/flags are allowed. Project recipes may not contain global install flags. No shell program is accepted as the installer executable. Source acquisition uses the built-in read-only backend; the command is available to the LLM for a separately approved alternate staging process, not silently launched by the helper.

Catalog `prerequisites` and optional local `SKILL.md` `requires` describe different contracts: installation closure and instruction loading. The catalog must cover declared local instruction requirements; complete-checkout validation checks that. Upstream skills can omit the nonstandard field. Installation does not create a native harness loader for it; target instructions or explicit skill usage must supply the loading convention. A missing requirement stops for approved setup.

## Fresh catalog snapshots

Normal CLI `inspect` resolves the trusted owner's tracking ref to a full commit and downloads the YAML at `.agents/skills/agentic-work/sync-my-skills/assets/skill-catalog.yaml` into fresh external temporary storage. `refresh` performs that data-only operation without a target. It validates the installed schema and the expected owner/ref. Unsupported data stops; no manager code is updated and no older catalog is chosen silently. Temporary storage is checked against target/source locations using canonical parent paths, so a custom `TMPDIR` or symlink cannot authorize a download into a repository or the manager package.

`inspect --bundled` explicitly selects the installed snapshot. `--source-root` without `--catalog` selects the complete checkout's catalog. `--catalog` selects an explicit snapshot. These modes skip the normal refresh, so they may omit newer entries. Bundled mode cannot be combined with those other selectors.

The returned `catalogSnapshot.path` must be carried with `--catalog` to preparation, read-only workspace reinspection, planning, and apply. A generated `.source.json` sidecar binds downloaded bytes to the owner/ref/commit and repository-relative catalog path. It is machine-owned provenance, not a second authored inventory. Edited snapshot bytes stop loading. A changed source pin invalidates a stage even if parsed YAML definitions are identical.

Authored acquisition uses that same owner commit. A local checkout override must be clean and match it. Explicit bundled/local review mode may instead use a different reviewed or dirty checkout, whose actual source bytes and dirty state are recorded. `catalogSource` in the lock stores the portable resolved catalog provenance, or `null` for bundled/local input without download provenance. It never contains the temporary machine path.

## Investigation and decisions

`inspect` returns project facts, current root-instruction paths/states, selectable bundle availability/prerequisites, shallow canonical/harness-specific installation locations, harness evidence, recommendations, **every** remaining active project entry, personal tooling, explicit deprecations, and earlier declines. It does not execute target code or install anything. Helper Git reads disable fsmonitor, hooks, and configured clean/smudge/process filters, with bounded command timeouts. Git status is a raw-file hint under those overrides, not proof of normal filter-aware cleanliness. Owner publication commands keep their normal configuration. Complete directory fingerprints are collected only for explicit removal plans, not for every unrelated installed package.

The agent must investigate actual purpose rather than equate file extensions with a coding project. The catalog always recommends `document-project`, `asd-ste100-technical`, and `unslop` as documentation guidance. Each can be declined, and the helper does not add them to installation closure unless selected or genuinely required. Every remaining project entry requires a decision. Incompatible entries remain visible with limitations. Personal tooling is visible separately; it is not part of the project selection.

The [selection schema](../assets/selection.schema.json) describes the outside-target decision file. For an illustrative two-entry catalog containing `alpha` and `beta`:

```json
{
  "selectedSkills": ["alpha"],
  "declinedSkills": [
    { "name": "beta", "reason": "User chose not to install now." }
  ],
  "harnesses": ["pi"],
  "removeSkills": [],
  "resolutions": {},
  "targetRequirements": "",
  "instructionFiles": [],
  "instructionApproval": ""
}
```

Use real catalog names for real projects. Closure adds prerequisites and explains them in the approval plan. Every other active project entry must appear in `declinedSkills`; a declined installed skill is retained, not deleted. Runtime/tool setup and capability limitations require decisions, not automatic installation.

`removeSkills` accepts only installed names in the explicit deprecation mapping. Unknown custom names and broad prefix matches cannot become removals. Exact-path `resolutions` are substantive notes for user-chosen conflicts under selected skill/projection paths or selected instruction files; they do not authorize writes outside that scope. The agent must show the actual diff and obtain approval of the resulting plan.

An empty `instructionFiles` selection preserves root documents. A nonempty selection must include `AGENTS.md`, `CONTRIBUTING.md`, `DOCUMENTATION.md`, and `VALIDATION.md`; only `CLAUDE.md` may be added. `instructionApproval` records the owner's separate approval of the displayed policy changes. Existing differing/unmanaged instructions also require exact-path resolutions. A legacy nonempty `rootFiles` value never authorizes adoption. No manager/bootstrap/core profile silently expands into a policy bundle.

See [Project instructions](project-instructions.md) before drafting. Required guidance must be explicitly selected or already installed and reviewed; installed versions and declared requirements are fingerprinted. Canonical template fields guide the LLM, not a substitution engine.

## External stage and semantic review

`prepare` requires a fresh stage outside source and target, both lexically and after resolving its nearest existing ancestor. Missing external parent directories are supported. Symlinked ancestors that would place the stage inside either repository are rejected before directory creation. Use the canonical stage path returned by preparation for later commands. A manager marker guards later operations:

- `raw/<name>/`: filtered source plus legal files; immutable during adaptation.
- `skills/<name>/`: candidate output for LLM edits.
- `templates/`: immutable source contract and selected canonical templates, when requested.
- `instructions/`: LLM-authored root candidates, when requested.
- `manifest.json`: the pinned catalog provenance, original/resolved sources, source digests/modes, recipes, target context, optional instruction target/prerequisite receipts, and reviews.

Selected-skill network acquisition requires explicit `--fetch`, independently of the normal catalog-only refresh. It reads data only; it never executes downloaded scripts or catalog argv. A source checkout with uncommitted changes is recorded as dirty rather than falsely claiming the commit alone identifies that content.

The LLM edits candidates according to intent and preserves substantive behavior, prerequisites, safety, and legal notices. `review` records a nonempty explanation and output digest. Adapted or otherwise modified candidates require a matching review. Changed output content or executable modes invalidate the review; review cannot waive excluded-file, metadata, or legal checks. Regular-file executable bits are preserved as normalized 0644/0755 modes; special permission bits are not imported. Conventional LICENSE/NOTICE/COPYING/OFL files and explicit legal targets must match raw bytes.

Unchanged approved adapted results can be reused when source input, recipe, target instruction/README context, explicit target requirements, and recorded installed files still match. Otherwise reassess and review. New upstream revisions are proposed/recorded deliberately; pinned upstream entries do not silently track a moving branch.

For instruction candidates, `review-instructions` checks source integrity, exact bundle scope, unresolved fields, visible fixed rules, consistent project names, output size, and private-path/credential constraints. It records technical review notes and evidence snapshots. Root instructions, README files, common manifests/configuration, and workflows are included automatically; `--evidence` supplies an array of additional relative files or verified absences. Custom command/configuration sources must be named explicitly. Changed evidence, installed guidance, or output invalidates the review/plan. A stage is bound to its actual instruction target.

Do not put credentials or unrelated private paths into requirements or review notes. Target documents and evidence are fingerprinted, not embedded in portable state. Static checks do not replace semantic review of required fields, preserved target policy, command truth, or owner decisions.

## Plan and apply

`plan` is non-mutating in the target and includes:

- exact normalized selection, harness subset, removals, and resolutions;
- immutable staged inputs, reviewed output, catalog/recipe identity, target context;
- current target Git branch/HEAD and before/after states;
- each write, obsolete-file removal, metadata removal, selected Claude projection, deprecated directory/link removal, and final lock write;
- whether legacy instruction records remain historical or selected files are explicitly adopted;
- a `planId` binding the complete result.

Only canonical `.agents/skills/<name>/...`, selected Claude projections, explicitly deprecated project skill locations, the manager lock, and the selected five-name instruction allowlist can change. Instruction actions are writes, never arbitrary root deletions. Nested instructions and unselected root files remain outside mutation scope. Existing shared canonical directories may be discoverable by an unselected harness; harness selection controls configuration/projections, not artificial visibility guarantees.

A local/unmanaged differing file or projection collision requires an exact reviewed resolution. Existing unmanaged OpenAI metadata under a selected skill receives an explicit policy-removal action. Obsolete managed source files are removed only when unchanged or explicitly resolved. Other extra/custom content stays intact.

`apply` requires `--apply --confirm --plan-id` and an isolated Git worktree. It rebuilds the plan and rechecks affected snapshots before the first write and during execution. Deprecated removal fingerprints include the complete directory/link state, including untracked extras; a new file invalidates approval. Snapshot traversal rechecks directory identity and file types instead of trusting cached directory entries. Regular-file reads use an opened descriptor with no-follow support and identity checks.

Each candidate write reads one buffer, verifies it against the approved action digest, and writes that same buffer. Changed bytes stop before that file is installed. Guidance/skill actions precede instruction writes; deferred documents precede `AGENTS.md` and the optional Claude import. The lock is written last. This is not a multi-file atomic transaction: an interrupted operation may leave partial files but must not claim successful lock recording. Preserve the worktree/stage, inspect, and obtain a new plan; never reset or blindly retry.

With no selected skills, omit `--skills` during preparation. An empty staged set still supports explicit retain/decline decisions or a deprecated-removal-only plan. No default removal occurs.

## Machine-owned lock and migration

[`../assets/ai-assets-lock.schema.json`](../assets/ai-assets-lock.schema.json) documents new version-3 `.agents/ai-assets.lock.json` writes. Skills CLI owns `skills-lock.json`; this helper never modifies it.

The lock records catalog/recipe fingerprints, normalized decisions, resolved source and original upstream provenance, legal mappings, per-file raw/installed digests, adaptation notes/output fingerprints, target-context hashes, and actual Claude projections. Absolute machine paths and credential material are rejected.

Version-1/2 locks can be read for an approved migration. Their root instruction records move to `legacyInstructions`, not active file management. Documents remain unchanged until explicit bundle adoption. Version-3 `files` may contain selected `instruction` records, and `instructions` stores template provenance, reviews, evidence, and guidance receipts. Each managed instruction file retains its own template origin so a retained optional Claude bridge is not attributed to a newer bundle. Unselected previously managed instruction records are retained, never automatically removed. Explicit adoption replaces the corresponding historical record. Declined old skill records retain their prior installed digest so local edits are not silently adopted as clean. Removed deprecated skills lose their records only under an approved removal plan.

Malformed or unsupported future locks stop. No implicit cleanup of unlisted skills, live personal commands, source branches, or workspaces is allowed.

## Personal command setup

`setup` is separate from project synchronization. It requires an already installed manager and parser. Plan first; apply only with both gates and the current plan ID. Use the requested harness subset.

Pi gets a personal prompt template, OpenCode gets a personal command Markdown file, and Claude gets a relative skill link. Files contain no model/provider overrides. Matching existing destinations are reused; conflicts stop without overwriting. Tests use disposable homes. Do not configure the owner's live home merely because implementation tests passed.

## Evidence and limits

Skills CLI installation is useful but does not inherently enforce this catalog's filtering or semantic adaptations. Native command behavior follows Pi's installed `docs/prompt-templates.md`, [OpenCode commands](https://opencode.ai/docs/commands/), and [Claude skills](https://code.claude.com/docs/en/skills). Static checks are not proof of live harness discovery or successful semantic LLM behavior. Check project discovery from the installed worktree, not the untouched primary checkout. Pi gates project `.agents/skills` on native project trust; non-interactive/RPC ask mode skips unapproved resources. The manager never saves a trust decision or grants that approval automatically.

Track implementation in [#69](https://github.com/dragoscirjan/ai/issues/69). Instruction adoption uses the canonical template bundle introduced for [#68](https://github.com/dragoscirjan/ai/issues/68), with separate user selection and policy approval.
