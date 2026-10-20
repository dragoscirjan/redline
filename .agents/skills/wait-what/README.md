# Wait What provenance

This directory contains a vendored copy of Matt Pocock's `wait-what` Agent Skill.

## Source

- Repository: [mattpocock/skills](https://github.com/mattpocock/skills)
- Skill directory: [skills/productivity/wait-what](https://github.com/mattpocock/skills/tree/main/skills/productivity/wait-what)
- Pinned revision: [`d80fa0f4ebe0c5714af0adf8670336065233ecc6`](https://github.com/mattpocock/skills/commit/d80fa0f4ebe0c5714af0adf8670336065233ecc6)
- Upstream commit date: 2026-09-17
- Copied on: 2026-10-20

| File | Upstream blob SHA | Vendored SHA-256 |
| --- | --- | --- |
| `SKILL.md` | `9b15cd1a7dda0854ca093e29e3e0de57e241b2ac` | `d961bb37defd975c539427edb8f450cdbccdcdd552e213c1ece46676a7970905` |
| `agents/openai.yaml` | `6f7a9c33f99ec4ba70d986d6fc0de06c8b811bc3` | `b41faadf741d51e4ea184148b2d1854d93f947aaf754c7844f70a00f04194999` |
| `LICENSE` | `f1dd2c09108dde1a5f56097cee8461b3ea834499` | `0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5` |

The skill is licensed under the upstream [MIT license](https://github.com/mattpocock/skills/blob/main/LICENSE). The notice is retained in [`LICENSE`](LICENSE).

## Checking for upgrades

Use the upstream skill directory as the canonical upgrade source:

https://github.com/mattpocock/skills/tree/main/skills/productivity/wait-what

Download the current upstream files and compare them before replacing the vendored copies:

```sh
mkdir -p /tmp/wait-what/agents
curl -fsSL \
  https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/wait-what/SKILL.md \
  -o /tmp/wait-what/SKILL.md
curl -fsSL \
  https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/wait-what/agents/openai.yaml \
  -o /tmp/wait-what/agents/openai.yaml

diff -u .agents/skills/wait-what/SKILL.md /tmp/wait-what/SKILL.md
diff -u .agents/skills/wait-what/agents/openai.yaml /tmp/wait-what/agents/openai.yaml
```

If an upgrade is accepted:

1. Replace the reviewed upstream files.
2. Refresh `LICENSE` from `https://raw.githubusercontent.com/mattpocock/skills/main/LICENSE` if it changed.
3. Update the revision, date, blob SHAs, SHA-256 values, and copy date in this README.
4. Confirm that the vendored upstream files are byte-identical to the recorded revision.
5. Validate skill discovery in each supported harness.

Keep local edits out of upstream files. If a local change is unavoidable, document the patch here and stop describing the affected file as byte-identical to upstream.
