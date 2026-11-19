# PHP rules

## Types and package contracts

- Composer platform constraints, PHP versions, and required extensions define supported syntax, types, attributes, and APIs.
- Follow the selected `strict_types` policy. Parameter, property, and return types must preserve supported call contracts.
- Distinguish `null`, `false`, empty strings, zero, and absent array keys. Loose comparisons can coerce them unexpectedly.
- Preserve exception causes and framework error conventions; release resources and roll back transactions on failure.
- Composer autoloading and namespaces define class resolution. Dynamic includes, class names, and callbacks can introduce executable boundaries.
- Named arguments make parameter names part of public compatibility. Preserve serialized formats, routes, templates, and migrations.

## Web and data boundaries

- Validate superglobals, request bodies, cookies, headers, uploads, and deserialized data before use.
- Parameterize SQL. HTML text, attributes, JavaScript, CSS, URLs, and headers require different escaping; template autoescaping is not universal.
- Restrict redirects and outbound destinations to prevent open redirects and SSRF. Reject header injection.
- Uploads need bounded sizes, validated media expectations, generated storage names, path containment, and non-executable storage.
- Untrusted `unserialize` objects, dynamic includes, reflection-driven construction, and callbacks can execute code.
- Use framework session, CSRF, authentication, authorization, and secure-cookie facilities. Protect each action, not only UI visibility.
- Secret comparisons may require timing-safe functions; caches and error output must not expose credentials.

## Tool defaults

- Syntax: `php -l` with the supported PHP version.
- Tests: [PHPUnit](https://phpunit.de/documentation.html), or framework-owned bootstrapping where required.
- Formatting: [PHP-CS-Fixer](https://cs.symfony.com/) in check/dry-run mode.
- Analysis: [PHPStan](https://phpstan.org/user-guide/getting-started) at the configured level.
- Metadata: `composer validate`; vulnerabilities: `composer audit`.
- Relevant cases include output contexts, authorization, uploads, exceptions, database rollback, and supported extensions.

References: [PHP Manual](https://www.php.net/manual/en/), [PHP-FIG PER Coding Style](https://www.php-fig.org/per/coding-style/). [PSR-12](https://www.php-fig.org/psr/psr-12/) applies where project compatibility requires it.
