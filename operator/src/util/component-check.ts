// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/component-check.ts — strict NG-gate over
// `ct-server-core component check` output.
//
// Mirrors scripts/lib.sh::component_check_strict. The CLI prints
// an OK/NG table; the bash original `grep -E '^[[:space:]]*NG[[:space:]]'`
// and awk-extracts the component name in column 2.
//
// Bash version returns 0 even on NG (the panel and JSON consumers
// need the full table); strict mode treats any NG row as failure.

import { $, capture } from "./sh";
import type { DiagFailure } from "./diag";

export interface ComponentCheckResult {
    readonly ok: boolean;
    readonly raw: string;
    readonly ngComponents: readonly string[];
    readonly failure?: DiagFailure;
}

// Pure: scan the table output for `NG <component>` rows and
// extract the deduped, sorted component name list. Exported for
// tests.
export function parseNgComponents(output: string): string[] {
    const set = new Set<string>();
    for (const line of output.split("\n")) {
        const m = line.match(/^\s*NG\s+(\S+)/);
        if (m) set.add(m[1]!);
    }
    return [...set].sort();
}

const NG_DIAG = `The new release built and started, but the component check
flagged components as NG (see name above). Targeted next steps
by component (read the FIRST one whose component matches):

  panel       -> docker compose logs --tail=120 panel
                 Common: composer install failed in entrypoint
                         (look for "platform-req" / "ext-redis"),
                         migration failed (/tmp/cool-tunnel/migrate-failed),
                         APP_KEY missing, or Octane worker crash.

  sing-box    -> docker compose logs --tail=60 singbox
                 docker compose exec panel php artisan singbox:render --if-changed
                 Common: rendered config invalid, port collision,
                         missing Reality key material, or supervisor
                         restart loop.

  redis       -> docker compose exec -T -e REDISCLI_AUTH="$REDIS_PASSWORD" redis redis-cli PING
                 Should print PONG. NG usually means AUTH failure
                 from a stale password.

  ct-server-core -> docker compose logs --tail=40 ct-core-daemon
                 Common: Redis auth/config mismatch or manifest pin
                         drift.

  caddy       -> docker compose logs --tail=40 caddy
                 Common: ACME failure (DNS, port 80/443 blocked),
                         cert path mtime not advancing.

The OLD release is still running on the volumes from before this
update -- your users are NOT impacted. You can roll back with:
  git checkout v0.0.95   # (or the prior known-good tag)
  ./ct update`;

// Run the strict component check. The bash original uses
// `/srv/manifests` as the manifests-dir default; we mirror that
// here as the standard production path.
//
// Pre-v0.1.18 the Bun port passed `--manifests-dir <path>`, but
// the Rust CLI flag is just `--manifests <path>` (clap's flag
// definition; see `core/ct-server-core/src/cli.rs`). The mismatch
// only surfaced in the final post-swap step of `./ct update`,
// because the two other call sites (doctor + readiness) already
// used `--manifests` correctly. Reported 2026-05-15 on the
// v0.1.16 Vultr update.
export async function runComponentCheckStrict(
    manifestsDir = "/srv/manifests",
): Promise<ComponentCheckResult> {
    const r = await capture(
        $`docker compose exec -T panel ct-server-core component check --manifests ${manifestsDir}`,
    );
    // The CLI prints to stdout; mix in stderr just in case a
    // future version dumps NG rows there.
    const raw = r.stdout + r.stderr;
    const ngComponents = parseNgComponents(raw);
    if (ngComponents.length === 0 && r.ok) {
        return { ok: true, raw, ngComponents };
    }
    return {
        ok: false,
        raw,
        ngComponents,
        failure: {
            summary: `post-swap check NG: ${ngComponents.join(",") || "unknown"}`,
            diag: NG_DIAG,
        },
    };
}
