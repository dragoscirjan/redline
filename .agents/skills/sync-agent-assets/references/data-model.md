# Sync agent asset data model

## Skill catalog

[`../assets/skill-catalog.json`](../assets/skill-catalog.json) is the source-owned catalog used for project detection and dependency closure. Its machine-readable schema is [`../assets/skill-catalog.schema.json`](../assets/skill-catalog.schema.json).

Top-level fields:

- `schemaVersion`: catalog schema version
- `profiles.manager`: the synchronization manager
- `profiles.bootstrap`: skills required before deep inspection
- `profiles.coreInstructions`: skills required by the imported instruction graph, including delegation policy when `AGENTS.md` routes child-agent work
- `skills`: every skill directory in the source repository

Each skill entry contains:

- `name`: exact skill directory and frontmatter name
- `category`: stable functional group
- `selection`: `manager`, `bootstrap`, `core`, `detected`, `wrapper`, `optional`, or `initializer`
- `dependencies`: required skill names
- `safety`: invocation risk summary
- `harnesses`: validated harnesses; this manager supports `pi`, `opencode`, and `claude-code`
- `requires`: optional harness capabilities
- `provenance`: `local` by default or an explicit external provenance class
- `signals.files`: project files or manifests that suggest applicability
- `signals.extensions`: source extensions that suggest applicability
- `signals.askWithoutSignals`: ask about the skill even when no stack signal exists

The helper rejects duplicate names, invalid names, missing dependencies, dependency cycles, profile references to missing skills, and catalog coverage that differs from source skill directories.

## Selection file

Create the selection file outside the target repository. Its schema is [`../assets/selection.schema.json`](../assets/selection.schema.json). It has this shape:

```json
{
  "selectedSkills": [
    "sync-agent-assets",
    "grill-me",
    "grilling",
    "isolated-workspace",
    "cleanup-workspaces",
    "subagent-orchestration",
    "instruction-maintenance"
  ],
  "declinedSkills": [
    {
      "name": "init-typescript",
      "reason": "The existing TypeScript toolchain is already configured."
    }
  ],
  "rootFiles": [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "VALIDATION.md"
  ],
  "adaptations": {
    "AGENTS.md": "Preserved the target's trunk branch and release authority.",
    "CONTRIBUTING.md": "Kept the existing issue and review process.",
    "VALIDATION.md": "Kept project-owned test and build commands."
  },
  "retainedFiles": [
    {
      "path": ".agents/skills/legacy-skill/SKILL.md",
      "reason": "Upstream removed the skill; migration is not approved yet."
    }
  ]
}
```

Rules:

- `selectedSkills` and `rootFiles` are required arrays.
- The helper adds the `manager`, `bootstrap`, and `coreInstructions` profiles plus their complete dependency closure to `selectedSkills`.
- `declinedSkills` entries require `name` and `reason` strings.
- `adaptations` records concise, non-sensitive project decisions.
- `retainedFiles` records previously managed files that remain unchanged until deletion, migration, or re-selection is approved.
- Every retained path must exist in the previous managed lock.
- Paths must be relative and remain inside the target root.
- Do not include credentials, temporary paths, or personal machine paths.

## Managed asset lock

`.agents/ai-assets.lock.json` is committed with the target project. The helper writes it only through an approval-bound `record` plan. The lock points to the installed [`../assets/ai-assets-lock.schema.json`](../assets/ai-assets-lock.schema.json).

The lock contains:

- `schemaVersion`: lock schema version
- `managerVersion`: synchronization helper version
- `source.repository`: source Git URL
- `source.ref`: requested branch, tag, or commit
- `source.commit`: exact applied commit
- `selection`: normalized selected skills, declined skills, root files, and adaptation notes
- `catalogSkills`: all catalogued skills at the applied source commit
- `files`: managed-file records keyed by target-relative path, including approved retained records
- `projections`: Claude Code project-skill symlinks keyed by `.claude/skills/<name>`

Each managed-file record contains:

- `kind`: `skill` or `instruction`
- `skill`: owning skill for skill files
- `sourcePath`: source-relative path
- `sourceSha256`: content digest at the pinned source commit
- `installedSha256`: content digest after approved installation or adaptation
- `retained`, `retentionReason`, and `retainedFromCommit`: retention metadata when an old managed file remains intentionally installed

Each Claude Code projection records:

- `harness`: `claude-code`
- `skill`: the canonical skill under `.agents/skills/`
- `target`: the exact relative symlink target `../../.agents/skills/<name>`

Old schema-version-1 locks without `projections` remain readable. The helper derives the expected projections from `selection.selectedSkills` and reports them as missing until the approved Claude Code installation creates them and a new record plan is applied.

The lock does not contain an absolute target path, source cache path, username, credential, token, or secret.

## Update states

`compare` emits these states:

| State | Meaning | Required action |
|---|---|---|
| `unchanged` | Source and target match their recorded digests. | None. |
| `upstream-changed-clean` | Upstream changed and the target copy was not edited. | Include the skill update in the plan. |
| `adaptation-required` | An upstream root instruction changed while the target adaptation stayed clean. | Regenerate and approve the adaptation. |
| `local-modified` | The target changed after recording while upstream did not. | Preserve and ask whether to adopt the local change. |
| `conflict` | Upstream and target both changed. | Grill and approve an exact merge. |
| `missing` | A managed target file is absent. | Ask whether to restore it or stop managing it. |
| `upstream-removed-retain` | Upstream removed the managed source file. | Retain it until deletion or migration is approved. |
| `retained-no-update` | The file remains by an earlier retention decision even though a source path exists. | Leave it unchanged until re-selection, deletion, or migration is approved. |

Projection status uses `clean`, `missing`, or `conflict`. A projection is clean only when it is the exact relative symlink from `.claude/skills/<name>` to `../../.agents/skills/<name>`. Existing files, directories, absolute links, or links to another target are conflicts and remain unchanged until replacement is explicitly approved.

A new source catalog name appears in `newCatalogSkills`. A removed catalog name appears in `removedCatalogSkills`. Neither list authorizes automatic installation or deletion.
