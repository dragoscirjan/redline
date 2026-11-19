# Create a temporary orchestration lane

Read this before planning an owner-approved temporary writable lane. The normal change keeps one canonical integration and pull-request workspace.

Use `${CANONICAL_REF}--lane-${LANE_KEY}` as the full branch or bookmark. The lane key is one safe path component. Its workspace name and leaf are the basename of the full ref. The reserved `--lane-` marker belongs only to temporary lane refs; reject it in a canonical ref.

Pass the canonical ref exactly through `--base`. The helper requires that explicit base and rejects nested lane provenance. A lane must never default to trunk or branch from another temporary lane.

For `change/issue-42`, the `worker-a` lane uses `change/issue-42--lane-worker-a` and sibling workspace `<repository>--workspaces/issue-42--lane-worker-a`. It is not inside the canonical workspace.

Give each concurrent writer exclusive files or a stable contract boundary and one isolated sibling workspace. Keep one writer per workspace. Before assigning a reused lane, inspect its status and provenance and confirm that all existing changes belong to this task and owner. Unrelated or uncertain changes block assignment.

Plan and apply through the main skill's helper and exact-plan approval gates. Temporary lanes remain subject to every normal path, registration, collision, environment, and existing-work protection.

Creation grants no cleanup authority. Follow the approved orchestration and separately selected cleanup procedure for integration and removal.
