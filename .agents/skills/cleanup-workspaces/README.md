# cleanup-workspaces

Audit integrated Git or Jujutsu workspaces, stale registrations, and temporary work areas for cleanup within explicitly approved targets.

## Dependencies

Requires `isolated-workspace` for workspace safeguards and shared helper code.

## Usage

Example request to an agent with the skill installed:

```text
Use cleanup-workspaces to audit integrated workspaces and propose an exact cleanup plan. Do not remove anything.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill. Install the dependencies listed above separately before using this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/utility/cleanup-workspaces" --skill cleanup-workspaces
```
