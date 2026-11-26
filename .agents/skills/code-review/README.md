# code-review

Review a change against the project's documented coding standards and the originating specification. Report standards and specification findings separately.

## Usage

Example request to an agent with the skill installed:

```text
Use code-review to review the changes since <base-ref> against this project's standards and the originating specification.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/code-review" --skill code-review
```

## Origin

Adapted from [code-review](https://github.com/mattpocock/skills/tree/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/engineering/code-review) at revision `59db609eb1e18aaf59b63284d0e52255aff0c63c`.
