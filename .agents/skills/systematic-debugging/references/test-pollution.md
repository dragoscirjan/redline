# Test pollution

Use when a test passes alone but fails after another test, in a suite, or under parallel execution.

## Establish the dependency

1. Run the failing test alone using the project's configured runner.
2. Reproduce the failing suite with a recorded seed, order, worker count, and environment.
3. Compare shared state before and after candidate predecessors: files, working directory, environment overrides, caches, globals, database records, timers, listeners, and child processes.
4. Narrow the predecessor set while preserving the ordering or concurrency that triggers the failure.
5. Confirm that the suspected test or group plus the victim reproduces the failure.

Use a fresh disposable test fixture or the project's cleanup mechanism between trials. Preserve pre-existing files and never recursively delete a real repository, database, or user directory to reset an experiment.

## Narrow without assuming monotonicity

A binary split can reduce a deterministic, order-preserving test sequence. It does not prove the cause when the failure requires several tests together or depends on timing. If splitting loses the failure, test interacting groups and control scheduling rather than declaring a test innocent.

Do not confuse state pollution with incomplete teardown, test discovery side effects, missing initialization, or a concurrency race. Record what each experiment rules out.

## Correct state ownership

Keep fixtures isolated, restore environment and process state, and release resources through the runner's supported lifecycle. Verify the suspected producer, the victim, and the combined suite, including parallel mode when relevant.

Do not fix pollution by permanently reordering tests, disabling parallelism, or deleting assertions unless a changed execution contract is explicitly approved.
