---
name: excalidraw
description: Generate PNG or SVG diagrams with local Excalidraw rendering. Use for project structure, component relationships, workflows, or revisions to an existing diagram. Retain scene JSON as editable source and deliver images first.
compatibility: Requires Node.js 22 or newer, the official @excalidraw/cli 0.3.0 package, and an installed Chrome, Chromium, Edge, or Firefox.
license: MIT
---

# Excalidraw diagrams

Produce the requested PNG or SVG. Keep the `.excalidraw` JSON as supporting source for later edits. Use PNG when the user has not selected an image format.

## Establish the diagram

1. Identify the question the image must answer, its audience, and its output location. Reuse an established project convention. Ask only when an unresolved choice prevents useful work.
2. For a project diagram, trace the relevant entry points, modules, and interfaces. Confirm each relationship against code or supplied evidence. Label assumptions and illustrative structures.
3. Select the smallest useful view. Group related components, use short labels, and keep one meaning per arrow. Omit detail that does not help answer the question.

## Check the local renderer

Use the official CLI at version 0.3.0. Check Node, `excalidraw --version`, and an installed supported browser. Read [the rendering guide](README.md) for setup, commands, and font handling.

An agent must obtain approval before downloading, installing, or upgrading dependencies, including a first `npx` download. If prerequisites are missing and installation is not approved, report the blocker.

Local rendering needs no login, API key, MCP server, hosted editor, or persistent canvas server. Use the CLI's local `render` and `mermaid` commands. Cloud workspace commands and share uploads are outside this workflow.

## Create or revise the source

- For a new simple diagram, author a Mermaid definition and convert it to scene JSON with `excalidraw mermaid`. For layouts Mermaid cannot express, author native scene JSON instead.
- Give elements stable IDs. Preserve IDs, drawing seeds, bindings, image files, and unrelated properties when editing an existing scene.
- Once a scene exists, use its JSON as the revision source. Make targeted structural or text changes there. A Mermaid file used for initial creation may be stale after scene edits; regenerate from it only when those edits are intentionally replaced.
- Keep the scene beside the final image unless the project specifies another location. Use a distinct output path or get approval before replacing existing work. Treat CLI `--out` paths as overwrite operations.
- Preserve the prior scene and image until a revised candidate renders and passes inspection. Move the accepted candidate into place only within the approved file scope.

## Render and inspect

1. Render the candidate scene to the requested image format using the guide's commands. Keep diagram contents in files or stdin rather than interpolating them into shell commands.
2. Open the resulting image. For SVG-only delivery, render a temporary PNG from the same scene if the available viewer cannot display SVG.
3. Check readable labels, unclipped text, distinct groups, connected arrows, sufficient contrast, and agreement with the verified project structure. Inspect the intended reading scale, not only a zoomed-in fragment.
4. Repair the JSON and rerender when a check fails. Preserve the scene's unaffected elements. Stop and report remaining defects if rendering or inspection cannot be completed.

A successful CLI exit alone does not establish visual quality. If the image cannot be viewed, report it as rendered but visually unverified.

## Deliver

Link the requested PNG or SVG first. Offer the scene JSON separately as editable source. State the view's scope, omitted detail that changes interpretation, and any unresolved assumptions or rendering limits.

When revising, summarize the substantive change. Use the saved JSON for subsequent edits rather than reconstructing the diagram from its image.
