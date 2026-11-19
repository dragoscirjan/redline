---
name: scaffold
description: "Create source skeletons for an approved feature, validate their structure, and stop before implementing behavior."
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Scaffold

Create real source skeletons, not a chat-only plan. Keep them structural and explicitly unfinished at every feature size. Introduce no business behavior, DSL, parser, generator, runtime, or agent extension.

## 1. Agree on the exact structure

Read project instructions and contribution policy. Inspect existing behavior, source, tests, public contracts, build configuration, and CI. Use project source conventions and its evidenced language/framework. Missing instructions block their phase; installation needs approval.

Establish the feature boundary and observable contracts, working implementations and entrypoints to preserve, minimal justified files/declarations/signatures/dependencies, unresolved requirements, and evidence for each structural choice.

Ask about unresolved data models, authorization, external contracts, or product behavior before choosing types, defaults, or comments. If language/framework evidence is absent, ask rather than select one.

Continue only with approval for the exact file-level scope. Earlier approval counts only when it covers that scope. Engineering guidance does not authorize business logic, speculative skeletons, or replacing requested source files with Markdown.

## 2. Verify the workspace and authority

Satisfy project workspace and approval gates. Verify the isolated path, branch/bookmark, base, status, and write ownership. Leave the primary checkout untouched.

Loading this skill grants no commit, push, pull-request, merge, or release permission. Follow the current request and project workflow; stop on a missing permission or conflicting gate.

## 3. Write the skeleton

- Write only the smallest justified files using existing names, layout, and type conventions. Use classes, interfaces, frameworks, or dependencies only when required by the approved structure.
- Add necessary types, declarations, signatures, and contracts. Abstract/interface declarations need no body.
- In an unimplemented callable body, leave a brief comment naming its agreed responsibility and a language-native fail-fast placeholder such as a not-implemented exception or panic. Exclude fake success values, fabricated data, empty no-op bodies, and module-load failures that break unrelated imports.
- Keep algorithms, external calls, side effects, and business logic unfinished. Placeholder failure must be explicit rather than masquerade as working behavior.
- Preserve existing working bodies and production entrypoints. If the structure cannot coexist safely, stop for revised scope rather than stub implementations or wire production to unfinished code.
- Keep comments about behavior or constraints, not hidden implementation, boilerplate footers, or invented requirements.

Keep separately requested simplification scope and approvals distinct. Simplification grants no permission to stub working behavior.

## 4. Validate the structural contract

Use project validation instructions and existing tools. Run state-writing checks only within the approved workspace and scope. Aim for syntax/type validity where feasible; tool installation or toolchain changes need approval.

Inspect the full diff for structural scope and preserved behavior. Verify every unimplemented callable body fails explicitly and no new production wiring reaches it. Use existing test conventions for justified contract checks, without asserting unfinished functionality works.

Report actual results, separating pre-existing, placeholder-related, and other new failures. Explain unrun checks. Preserve tests and failures instead of weakening or skipping checks, suppressing errors, or fabricating passes. Compilation is not feature completion.

## 5. Hand off and stop

Retain the real files in the approved workspace. Publish a clearly labeled scaffold-only PR only when authorized. Include the issue or approved scope, changed files, unfinished behavior, checks and gaps, and decisions still required.

Report files, any PR, branch/bookmark, workspace, and gaps without repeating source in chat. If publication is unauthorized, report that boundary without pushing.

Stop at the scaffold handoff. Implementing behavior requires a separate explicit instruction; scaffold approval or merging its PR is not that instruction and grants no merge or release authority.
