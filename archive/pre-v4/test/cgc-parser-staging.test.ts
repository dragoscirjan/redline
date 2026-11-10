import { execaSync } from 'execa';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const loader = fileURLToPath(new URL('../containers/preload-cgc-parsers.py', import.meta.url));
const program = `
import importlib.util
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("grammar_staging", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = sys.argv[2]
with tempfile.TemporaryDirectory(prefix="redline-parser-stage-") as temporary:
    root = Path(temporary)
    source, destination = root / "cache", root / "staged"
    source.mkdir()
    (source / "parser.so").write_bytes(b"synthetic-parser")
    outside = root / "outside-marker"
    outside.write_text("synthetic-outside-marker")
    outside_dir = root / "outside-directory"
    outside_dir.mkdir()
    (outside_dir / "marker").write_text("synthetic-directory-marker")
    if scenario == "root":
        source.rename(root / "original-cache")
        source.symlink_to(outside_dir, target_is_directory=True)
    elif scenario in {"file", "directory", "broken"}:
        target = outside_dir if scenario == "directory" else root / "missing" if scenario == "broken" else outside
        (source / "escape").symlink_to(target, target_is_directory=scenario == "directory")
    elif scenario == "late":
        original = module.shutil.copytree
        def create_late_link(src, dst, **options):
            (source / "escape").symlink_to(outside)
            return original(src, dst, **options)
        module.shutil.copytree = create_late_link
    try:
        module.stage_parsers(source, destination)
    except RuntimeError as error:
        if scenario == "late":
            assert str(error) == "CGC parser staging contains a symlink"
            assert (destination / "escape").is_symlink()
        else:
            assert scenario != "healthy"
            assert str(error) == "CGC parser cache contains a symlink"
            assert not destination.exists()
    else:
        assert scenario == "healthy", "unsafe cache was accepted"
        assert (destination / "parser.so").read_bytes() == b"synthetic-parser"
    assert outside.read_text() == "synthetic-outside-marker"
`;

it.each(['healthy', 'file', 'directory', 'root', 'broken', 'late'])('stages parser cache safely for %s', scenario => {
  const result = execaSync('python', ['-B', '-c', program, loader, scenario], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmpdir(), TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir() },
    extendEnv: false, preferLocal: false, shell: false, verbose: 'none', timeout: 10_000, maxBuffer: 32 * 1024,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('');
});
