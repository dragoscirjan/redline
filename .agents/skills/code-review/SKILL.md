---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
license: MIT
compatibility: Requires Git and a harness that can run two read-only subagents in parallel.
metadata:
  author: Matt Pocock
  source: https://github.com/mattpocock/skills/tree/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/engineering/code-review
  upstream-commit: "59db609eb1e18aaf59b63284d0e52255aff0c63c"
---

Review the diff between HEAD and a user-supplied fixed point along two independent axes:

- **Standards:** conformance to documented repository standards.
- **Spec:** conformance to the originating issue or specification.

Use separate parallel, read-only subagents. They may inspect state and run non-mutating checks, but must not edit, commit, push, post comments, or delegate. Aggregate both reports without letting one axis mask the other.

## 1. Pin the comparison

Ask for a fixed point if none was supplied. Resolve it and HEAD to immutable commit IDs before review. Stop on an invalid ref or empty diff.

For a review “since” a branch/ref, compare its merge-base with the pinned HEAD. If the user explicitly requests exact endpoint snapshots, compare those endpoints instead; do not silently substitute a merge-base:

```sh
HEAD_SHA=$(git rev-parse --verify 'HEAD^{commit}')
BASE_SHA=$(git rev-parse --verify --end-of-options "${FIXED_POINT}^{commit}")
# Default since-ref comparison:
LEFT_SHA=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
# For an explicit endpoint comparison, use LEFT_SHA=$BASE_SHA instead.
git diff --no-ext-diff --no-textconv "$LEFT_SHA" "$HEAD_SHA"
git log "$BASE_SHA..$HEAD_SHA" --oneline
```

Give both reviewers the same resolved IDs, comparison mode, diff, and commit list. Read surrounding source from those snapshots, not a dirty or moving worktree: use `git show "$HEAD_SHA:path"` for reviewed code and the left snapshot for removed/old code. Do not move refs, discard local edits, or create a worktree merely to obtain context.

## 2. Locate the specification

Use the repository's configured issue tracker. Find the spec in this order:

1. Issue references in commit messages, fetched through configured tracker tools.
2. A user-supplied path.
3. A matching file under docs/, specs/, or .scratch/.
4. Ask the user if none was found or the tracker is unavailable.

If the user confirms no spec exists, skip only the Spec reviewer and report “no spec available.” Never invent requirements.

## 3. Locate standards and carry the smell baseline

Find repository documents governing code, always including CODING_STANDARDS.md and CONTRIBUTING.md when present.

The Standards reviewer also receives the complete Fowler smell baseline below. Documented repository standards override these heuristics. Label smells as possible issues, not hard violations, and suppress duplicate findings only when the relevant check completed successfully on the reviewed snapshot. If tooling is unavailable, failed, or unrun, report source-proven defects and disclose that limit. Refactor only when the context justifies the suggested remedy.

- **Mysterious Name:** intent is unclear. Rename honestly; an impossible name may indicate unclear design.
- **Duplicated Code:** repeated logic represents the same concept. Consider a shared implementation.
- **Feature Envy:** behavior chiefly uses another object's data. Consider moving it to that owner.
- **Data Clumps:** fields repeatedly travel together. Consider a cohesive type.
- **Primitive Obsession:** primitives obscure a meaningful domain concept. Consider a small domain type.
- **Repeated Switches:** dispatch on the same type repeats. Consider one shared map or appropriate polymorphism.
- **Shotgun Surgery:** one logical change needs scattered edits. Consider gathering the responsibility.
- **Divergent Change:** one module changes for unrelated reasons. Consider splitting responsibilities.
- **Speculative Generality:** unsupported future needs caused abstractions, parameters, or hooks. Remove the unnecessary mechanism.
- **Message Chains:** callers navigate internal object structure. Consider hiding that navigation.
- **Middle Man:** a class/function mostly forwards calls. Consider calling the actual target.
- **Refused Bequest:** an inheritor rejects most inherited behavior. Consider composition instead.

## 4. Launch the independent reviewers together

Before either launch, check remaining project/harness reviewer capacity, counting earlier and failed attempts. If both required reviewers will not fit, ask the owner to raise the limit or stop. Never silently drop an axis or exceed the limit.

Each receives the diff command, commit list, read-only boundary, and its own evidence sources. Keep their contexts and reports separate.

**Standards reviewer:** include the standards-file list and paste the full smell baseline. Aim for a concise summary around 400 words, without omitting concrete findings; retain a complete report when needed. Cover:

- Documented-standard violations by file/hunk, citing the source file and rule.
- Possible baseline smells, naming the smell and quoting the hunk.
- A clear distinction between hard documented breaches and contextual heuristics. Repository rules win; suppress only duplicates covered by a successful relevant check on the reviewed snapshot.

**Spec reviewer:** include the spec path or fetched contents. Aim for a concise summary around 400 words, without omitting concrete findings; retain a complete report when needed. Cover:

- Missing or partial requirements.
- Unrequested behavior or scope creep.
- Apparently implemented requirements whose behavior is wrong.

Require a spec quotation for each finding. If the spec is unavailable under step 2, do not launch that reviewer.

## 5. Report each axis separately

Present the reports under **Standards** and **Spec**, verbatim or lightly cleaned. Do not merge, rerank, or choose an overall winning axis.

End with the finding count and worst issue within each axis, if any. One axis may pass while the other fails: correct implementation can violate standards, and standards-compliant code can implement the wrong requirement. State unverified checks and the skipped-spec condition explicitly.
