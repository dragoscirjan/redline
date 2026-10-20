# Grilling provenance

This directory contains a vendored copy of Matt Pocock's `grilling` Agent Skill.

## Source

- Repository: [mattpocock/skills](https://github.com/mattpocock/skills)
- Skill directory: [skills/productivity/grilling](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling)
- Pinned revision: [`95249b0b49782349740fd9b8c6ce32b4e59e497a`](https://github.com/mattpocock/skills/commit/95249b0b49782349740fd9b8c6ce32b4e59e497a)
- Upstream commit date: 2026-10-07
- Copied on: 2026-10-15

| File | Upstream blob SHA | Vendored SHA-256 |
| --- | --- | --- |
| `SKILL.md` | `df69d9936880cd3314c28858c6c52f48db23b856` | `befdff1e27a1dfe2a294d5871169ac1afe16d983911daa4f32627514a48c1e15` |
| `agents/openai.yaml` | `ddbdb96139c0c1dfe6bca698f39d0465674b8a39` | `1411d7df7d99b7e621a1ff8283c8133cc2464be63d064e52d8ce169c6800ee9b` |
| `LICENSE` | `f1dd2c09108dde1a5f56097cee8461b3ea834499` | `0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5` |

The skill is licensed under the upstream [MIT license](https://github.com/mattpocock/skills/blob/main/LICENSE). The notice is retained in [`LICENSE`](LICENSE).

## Checking for upgrades

Use the upstream skill directory as the canonical upgrade source:

https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling

Download the current upstream files and compare them before replacing the vendored copies:

```sh
mkdir -p /tmp/grilling/agents
curl -fsSL \
  https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md \
  -o /tmp/grilling/SKILL.md
curl -fsSL \
  https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/agents/openai.yaml \
  -o /tmp/grilling/agents/openai.yaml

diff -u .agents/skills/grilling/SKILL.md /tmp/grilling/SKILL.md
diff -u .agents/skills/grilling/agents/openai.yaml /tmp/grilling/agents/openai.yaml
```

If an upgrade is accepted:

1. Replace the reviewed upstream files.
2. Refresh `LICENSE` from `https://raw.githubusercontent.com/mattpocock/skills/main/LICENSE` if it changed.
3. Update the revision, date, blob SHAs, SHA-256 values, and copy date in this README.
4. Confirm that the vendored upstream files are byte-identical to the recorded revision.
5. Validate skill discovery in each supported harness.

Keep local edits out of upstream files. If a local change is unavoidable, document the patch here and stop describing the affected file as byte-identical to upstream.
