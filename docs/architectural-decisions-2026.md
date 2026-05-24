# Architectural Decision Notes

This repository previously carried a long historical audit manual for the retired PHP/Laravel/Filament panel. The current architecture is intentionally smaller:

- Bun/TypeScript owns the operator CLI, admin web server, Better Auth integration, first-owner setup, roles, diagnostics, and docs.
- SQLite is the default admin/account database.
- MariaDB and Redis are retained only where existing core runtime behavior still requires them.
- Rust remains the internal trusted core for protocol, render, daemon, and runtime logic.
- No default admin password is created. First owner setup uses `ct admin bootstrap` with an expiring one-time token.

Current operational references live in `README.md`, `GETTING_STARTED.md`, `docs/architecture.md`, and `docs/operator-runbook.md`.
