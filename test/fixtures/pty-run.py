"""Run trusted test argv under a PTY. Raw mode keeps tee and terminal bytes comparable."""
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time
import tty


def main() -> int:
    master, slave = pty.openpty()
    tty.setraw(slave)
    process = None
    try:
        process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave,
                                   stderr=slave, start_new_session=True)
        os.close(slave)
        slave = -1
        deadline = time.monotonic() + 75
        total = 0
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("PTY test deadline exhausted")
            if not select.select([master], [], [], 0.1)[0]:
                if process.poll() is not None:
                    break
                continue
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            total += len(data)
            if total > 2 * 1024 * 1024:
                raise RuntimeError("PTY test output limit exceeded")
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        return process.wait(timeout=5)
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        if slave >= 0:
            os.close(slave)


if __name__ == "__main__":
    raise SystemExit(main())
