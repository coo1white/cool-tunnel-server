// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/repo-root.ts — chdir-to-repo-root, /$bunfs-safe.

// In dev (`bun run operator/<script>.ts`) `import.meta.url` resolves
// to a real `file://...` URL; walking `..` lands at the repo root.
//
// In a compiled binary (`bun build --compile`), Bun bundles sources
// into a synthetic `/$bunfs/...` virtual filesystem. `import.meta.url`
// points INTO /$bunfs/, and `new URL("..", ...).pathname` resolves to
// `/$bunfs` — a path that exists only inside the binary's runtime,
// not on the host. v0.1.13 + v0.1.14 unconditionally chdir'd there
// and died with:
//     ENOENT: no such file or directory, chdir <cwd> -> '/$bunfs'
//
// The `./ct` wrapper cd's into the repo before exec'ing the binary
// (`cd "$SCRIPT_DIR"` at line 42 of `ct`), so `process.cwd()` is
// correct on entry. Only chdir in dev where `import.meta.url`
// resolves to a real host path.

/**
 * Ensure the current working directory is the repo root.
 *
 * Callers pass their own `import.meta.url` (passing the helper's
 * own `import.meta.url` would always resolve to operator/src/util/,
 * which is wrong by one level).
 */
export function ensureRepoRoot(callerImportMetaUrl: string): void {
  if (isBunFsUrl(callerImportMetaUrl)) {
    // Compiled-binary path. Trust process.cwd() — `./ct` set it
    // for us; manual `cd /path/to/repo && ./ct <cmd>` does too.
    return;
  }
  const repoRoot = new URL("..", callerImportMetaUrl).pathname.replace(/\/$/, "");
  process.chdir(repoRoot);
}

/**
 * Exposed for testing — pure predicate, no I/O.
 */
export function isBunFsUrl(url: string): boolean {
  return url.includes("/$bunfs/");
}
