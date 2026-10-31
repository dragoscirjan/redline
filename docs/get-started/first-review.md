# Run your first review

This example checks capture, review execution, and output without an API key. It uses `echo`, which always returns a clean answer. It does not perform model-based code review.

## 1. Create a disposable repository

Choose a new directory outside your existing projects. These commands create and commit the example there; they do not belong in your project repository. If `mkdir` reports that the directory already exists, stop and choose another name before continuing.

```sh
mkdir redline-demo
cd redline-demo
git init
git config user.name "Redline demo"
git config user.email "redline-demo@example.invalid"
node -e "require('node:fs').writeFileSync('example.ts', 'export const value = 1;\n')"
git add example.ts
git commit -m "Add demo file"
```

The identity settings apply only to this disposable repository.

## 2. Change the tracked file

```sh
node -e "require('node:fs').writeFileSync('example.ts', 'export const value = 2;\n')"
git status --short
```

Git should report `example.ts` as modified. You need a tracked change because the default review excludes untracked files.

## 3. Run the safe review

If Redline is installed:

```sh
redline review --harness echo --indexing disabled
```

If you are using the source checkout, run this from the demo directory instead:

```sh
node /path/to/redline/bin/redline.mjs review --harness echo --indexing disabled
```

Replace `/path/to/redline` with the checkout's full path. On Windows, use the full Windows path and quote it if it contains spaces. Keep the current directory set to the demo repository so Redline reviews the demo, not its own checkout.

## 4. Check the result

Expect:

- one required file completed, with no failed files;
- no findings, because `echo` supplies a clean answer;
- a printed artifact directory containing the captured change and review output.

`git status --short` should still show your modified file. Redline does not stage, commit, or apply changes.

A clean `echo` result proves that the workflow ran. It does not prove that the change is correct. [Connect a model](/get-started/configuration) to perform an actual code review, or read [where the results are stored](/results).
