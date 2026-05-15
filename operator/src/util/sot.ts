// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/sot.ts — Cycle 3 / v0.0.55 panel-hostname SoT
// cross-language parity matrix.
//
// Used by both surfaces:
//   - operator/verify-sot.ts (dev-side `make verify-sot`, vps-side
//     `make verify-sot-vps`)
//   - operator/src/diag/collectors/ballast.ts (sot-parity check
//     during `ct ballast` / `ct doctor`)
//
// Two implementations of panel_domain live in the tree:
//   - PHP:  panel/config/cool-tunnel.php
//   - Rust: core/ct-server-core/src/util/domain.rs
// Both must agree byte-for-byte. PHP returns "" when both envs are
// unset (deferred fail for Laravel bootstrap contexts); Rust exits
// non-zero (fail-fast for runtime invocations). Both are treated as
// equivalent fail signals on the all-empty fixture.

export interface Fixture {
    readonly label: string;
    readonly domain: string;
    readonly panel_domain: string;
    // `null` = expect a fail signal: PHP empty AND Rust non-zero exit.
    readonly expected: string | null;
}

// The same five fixtures the bash originals (verify_sot.sh,
// verify_sot_vps.sh) ran. Adding a fixture here covers both surfaces
// in one place — that's the whole point of this module.
export const FIXTURES: readonly Fixture[] = [
    {
        label: "explicit PANEL_DOMAIN takes priority",
        domain: "example.com",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    },
    {
        label: "empty PANEL_DOMAIN falls back to panel.<DOMAIN>",
        domain: "example.com",
        panel_domain: "",
        expected: "panel.example.com",
    },
    {
        label: "empty DOMAIN with explicit PANEL_DOMAIN",
        domain: "",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    },
    {
        label: "whitespace PANEL_DOMAIN trimmed → fallback",
        domain: "example.com",
        panel_domain: "   ",
        expected: "panel.example.com",
    },
    {
        label: "both empty fails fast",
        domain: "",
        panel_domain: "",
        expected: null,
    },
];

export interface ProbeResult {
    readonly php: string;
    readonly rust: string;
    readonly rustExit: number;
}

export type Runner = (fixture: Fixture) => Promise<ProbeResult>;

export interface FixtureOutcome {
    readonly fixture: Fixture;
    readonly probe: ProbeResult;
    readonly pass: boolean;
}

// Pure equivalence check. Bash-original semantics preserved
// verbatim:
//   - For a "<fail>" fixture: PHP empty AND Rust non-zero exit ⇒ pass.
//   - Otherwise: PHP == Rust == expected AND Rust exit 0 ⇒ pass.
export function checkOutcome(fixture: Fixture, probe: ProbeResult): boolean {
    if (fixture.expected === null) {
        return probe.php === "" && probe.rustExit !== 0;
    }
    return probe.php === probe.rust && probe.php === fixture.expected && probe.rustExit === 0;
}

export interface RunSummary {
    readonly outcomes: readonly FixtureOutcome[];
    readonly passed: number;
    readonly failed: number;
}

// Loop the fixture matrix using a caller-supplied runner. The
// runner abstracts over host (php / cargo on PATH) vs vps (docker
// compose exec inside the panel container) — see operator/verify-sot.ts.
export async function runFixtures(runner: Runner): Promise<RunSummary> {
    const outcomes: FixtureOutcome[] = [];
    let passed = 0;
    let failed = 0;
    for (const fixture of FIXTURES) {
        const probe = await runner(fixture);
        const pass = checkOutcome(fixture, probe);
        outcomes.push({ fixture, probe, pass });
        if (pass) passed++;
        else failed++;
    }
    return { outcomes, passed, failed };
}

// Human-readable fixture line for `make verify-sot` output. The
// bash version printed `  ✓ <label>` for pass and a multi-line
// expected/got block for fail; we keep that shape exactly so a
// diff against bash output stays small if anyone forensically
// compares them.
export function formatOutcome(o: FixtureOutcome): string {
    if (o.pass) return `  ✓ ${o.fixture.label}`;
    const lines: string[] = [`  ✗ ${o.fixture.label}`];
    if (o.fixture.expected === null) {
        lines.push(`      expected: <fail> (PHP empty + Rust non-zero exit)`);
        const isEmpty = o.probe.php === "" ? "true" : "false";
        lines.push(`      PHP:      ${JSON.stringify(o.probe.php)} (empty=${isEmpty})`);
        lines.push(`      Rust:     ${JSON.stringify(o.probe.rust)} (exit=${o.probe.rustExit})`);
    } else {
        lines.push(`      expected: ${JSON.stringify(o.fixture.expected)}`);
        lines.push(`      PHP:      ${JSON.stringify(o.probe.php)}`);
        lines.push(`      Rust:     ${JSON.stringify(o.probe.rust)} (exit=${o.probe.rustExit})`);
    }
    return lines.join("\n");
}
