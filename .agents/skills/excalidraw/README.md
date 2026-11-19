# Generate a project diagram

Use this skill for a simple project-structure image, component diagram, or workflow. PNG and SVG are the deliverables. The scene JSON is supporting source for later revisions.

## Prerequisites

- Install this skill under `.agents/skills/excalidraw/` in the target project.
- Use Node.js 22 or newer.
- Have Chrome, Chromium, Edge, or Firefox installed. Rendering runs the browser headlessly with a temporary profile.
- Use the official `@excalidraw/cli` package at version 0.3.0.

Pi and OpenCode use the canonical skill directory. Claude Code uses the corresponding relative `.claude/skills/excalidraw` symlink supplied by this repository. Runtime dependencies are separate from skill installation.

Check the installed versions:

```sh
node --version
excalidraw --version
```

If the CLI is missing, approve the dependency download before an agent installs it. A human can install the pinned version with:

```sh
npm install --global @excalidraw/cli@0.3.0
```

No Excalidraw account, API key, MCP configuration, or canvas server is needed for the local commands below. Do not use a different package named `excalidraw` as a substitute for `@excalidraw/cli`.

## Render the included example

Run from the target project's root after installing the skill. The [example](examples/project-structure.mmd) is illustrative, not a claim about that project's architecture.

The commands overwrite matching output files. Choose another basename if these files already exist.

```sh
mkdir -p docs/diagrams
excalidraw mermaid .agents/skills/excalidraw/examples/project-structure.mmd --out docs/diagrams/project-structure.excalidraw
excalidraw render docs/diagrams/project-structure.excalidraw --out docs/diagrams/project-structure.png --scale 2
excalidraw render docs/diagrams/project-structure.excalidraw --out docs/diagrams/project-structure.svg
```

Open the PNG and SVG. Both should show a CLI calling an application, with the application connected to domain logic and a storage adapter. Deliver the requested image and retain the scene JSON for revision.

For a real project, ask the agent to inspect the relevant code and replace this illustrative structure. For example:

> Draw a PNG showing how this project's CLI reaches its domain logic and storage adapters. Keep the view simple, verify the connections against code, and retain the scene JSON for later edits.

## Revise an image

Ask the agent to edit the saved `.excalidraw` JSON, render to a candidate image, and inspect it before replacing the accepted output. For example:

> Add the cache between the application and storage adapter, preserving the existing layout and IDs. Generate a new SVG from the revised JSON.

The original Mermaid file is only an initial authoring aid. It does not automatically reflect later scene edits.

## Rendering options and recovery

- The `--out` extension selects PNG or SVG. Use `--scale 2` for a higher-resolution PNG, `--transparent` for no background, or `--theme dark` for dark output.
- If the CLI cannot find the browser, pass `--browser-path` with its installed executable path.
- For strict local font sourcing, pass `--fonts-url` with a local copy of `@excalidraw/excalidraw@0.18.1`'s `dist/prod/` folder. Some CJK fonts otherwise download on first use and are cached.
- `--fonts-url none` disables font downloads but may use fallback glyphs. Inspect wrapping and label widths after any font warning.
- Images must be embedded in scene data. The renderer does not load external image URLs or website embeds.
- A missing browser, parse failure, nonzero exit, or unreadable output is a blocker. Preserve the last accepted image and fix the cause before replacing it.

For SVG-only requests, a temporary PNG can support visual inspection without becoming another deliverable.

## Upstream references

Command examples target official CLI 0.3.0. Check its help before changing the pinned version. Older utility-package examples use different export APIs.

- [Official CLI and prerequisites](https://github.com/excalidraw/cli/blob/d1e716f1aef2c2417772366b3869bbaee7b385c6/README.md)
- [Local rendering, limits, and fonts](https://github.com/excalidraw/cli/blob/d1e716f1aef2c2417772366b3869bbaee7b385c6/docs/rendering.md)
- [Mermaid conversion](https://github.com/excalidraw/cli/blob/d1e716f1aef2c2417772366b3869bbaee7b385c6/docs/mermaid.md)
