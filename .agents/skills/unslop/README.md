# Unslop provenance

This directory contains a vendored copy of the `unslop` Agent Skill from Cursor's `plugins` repository.

## Source

- Repository: [cursor/plugins](https://github.com/cursor/plugins)
- Skill directory: [pstack/skills/unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)
- Copied file: [SKILL.md at `bc697d0a5a163cec979e362b601e36f5616083fd`](https://github.com/cursor/plugins/blob/bc697d0a5a163cec979e362b601e36f5616083fd/pstack/skills/unslop/SKILL.md)
- Upstream commit date: 2026-10-12
- Upstream blob SHA: `97f5b6412148fa5b2a2fe478836fe8923ffa5cbb`
- Vendored SHA-256: `ccab208e315ce05e2fab8eeee2f7879f1289b5c6844840b2d307adf31c79144f`
- Copied on: 2026-10-15

The skill is licensed under the upstream [pstack MIT license](https://github.com/cursor/plugins/blob/main/pstack/LICENSE). The required notice is retained in [`LICENSE`](LICENSE).

## Checking for upgrades

Use the upstream skill directory as the canonical upgrade source:

https://github.com/cursor/plugins/tree/main/pstack/skills/unslop

Compare the local file with the current upstream version before replacing it:

```sh
curl -fsSL \
  https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md \
  -o /tmp/unslop-SKILL.md

diff -u .agents/skills/unslop/SKILL.md /tmp/unslop-SKILL.md
```

If an upgrade is accepted:

1. Replace `SKILL.md` with the reviewed upstream file.
2. Refresh `LICENSE` from `https://raw.githubusercontent.com/cursor/plugins/main/pstack/LICENSE` if it changed.
3. Update the commit, date, blob SHA, SHA-256, and copy date in this README.
4. Confirm that `SKILL.md` remains byte-identical to the recorded upstream revision.
5. Validate skill discovery in each supported harness.

Keep local edits out of `SKILL.md`. If a local change is unavoidable, document the patch in this README and stop describing the file as byte-identical to upstream.
