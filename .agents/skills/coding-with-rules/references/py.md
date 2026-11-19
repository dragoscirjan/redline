# Python rules

## Values, typing, and async

- Interpreter versions and implementations constrain syntax, standard-library APIs, annotation forms, and packaging compatibility.
- Use context managers for files, locks, transactions, and temporary resources.
- Avoid mutable default arguments and accidental shared class state. Copy or freeze values according to ownership.
- Raise specific exceptions, preserve causes, and recover only where a caller can act on the failure.
- Coroutines need explicit task ownership, cancellation, timeouts, and asynchronous cleanup. Blocking synchronous work needs a deliberate event-loop boundary.
- Annotations do not replace runtime validation. Broad `Any`, casts, and ignores can conceal unmodeled data.
- Preserve public imports, call signatures, serialization formats, and package import layout.

## Dynamic and process boundaries

- Untrusted input must not reach `eval`, `exec`, or dynamic imports.
- `pickle`, `marshal`, `shelve`, and unsafe YAML loading can execute code.
- Pass subprocess arguments as a sequence. Avoid `shell=True` for untrusted values.
- Filesystem extraction needs containment, symlink, archive-member, and upload-name checks.
- Bound parsing, decompression, network reads, regex work, retries, and concurrency.
- Package metadata and transitive dependencies belong to the package/lockfile trust boundary.

## Tool defaults

- Tests: [pytest](https://docs.pytest.org/).
- Formatting/lint: [Ruff](https://docs.astral.sh/ruff/).
- Types: [Pyright](https://microsoft.github.io/pyright/).
- Security analysis: [Bandit](https://bandit.readthedocs.io/).
- Dependency vulnerabilities: [pip-audit](https://pypi.org/project/pip-audit/).
- [Pylint](https://pylint.readthedocs.io/) is supplementary for relevant checks not already covered by selected lint rules.
- Relevant cases include supported interpreters, exceptions, scoped cleanup, async cancellation, packaging, and runtime type boundaries.

References: [PEP 8](https://peps.python.org/pep-0008/), [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html).
