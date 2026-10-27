#!/usr/bin/env python3
"""Hold the private index-cache OS lock until the owning Node process closes stdin."""
import os
import stat
import sys
import time


def main() -> int:
    path, timeout = sys.argv[1:]
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "r+b", buffering=0) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1 or info.st_nlink != 1:
            return 2
        if info.st_size == 0:
            try:
                handle.write(b"\0")
            except PermissionError:
                # Another Windows helper may initialize and lock byte zero
                # between our fstat and write. Wait for its lock normally.
                if os.fstat(handle.fileno()).st_size != 1:
                    raise
        deadline = time.monotonic() + float(timeout)
        while True:
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    return 3
                time.sleep(0.05)
        print("locked", flush=True)
        # EOF also releases the lock after an unhandled Node crash. No PID
        # takeover or stale-lease deletion can race another writer.
        sys.stdin.buffer.read(1)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        raise SystemExit(2)
