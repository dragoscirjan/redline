# excalidraw

Produce editable Excalidraw diagrams and locally rendered PNG or SVG images for project structure, relationships, and workflows.

## Usage

Example request to an agent with the skill installed:

```text
Use excalidraw to illustrate these component relationships. Provide an editable diagram source and a PNG or SVG image.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/documentation/excalidraw" --skill excalidraw
```
