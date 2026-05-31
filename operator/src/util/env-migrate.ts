// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/env-migrate.ts — .env auto-migration logic
// for ct update's "Auto-migrate legacy .env" step.
//
// Four idempotent phases (preserving the bash original's order):
//   1. Backfill `PANEL_DOMAIN=panel.${DOMAIN}` immediately after
//      the DOMAIN= line when PANEL_DOMAIN is missing entirely.
//   2. Relocate PANEL_DOMAIN to BEFORE the first non-comment line
//      that references ${PANEL_DOMAIN} — fixes the pre-v0.0.68
//      buggy backfill that appended PANEL_DOMAIN to file-end,
//      after APP_URL=https://${PANEL_DOMAIN}/admin, leaving compose
//      with "The PANEL_DOMAIN variable is not set" warnings on
//      every invocation.
//   3. Substitute `APP_URL=https?://${DOMAIN}` → `…${PANEL_DOMAIN}`
//      (the pre-v0.0.68 APP_URL shape causes Livewire 3 419s).
//   4. Backfill sing-box direct outbound dial defaults so old VPSes
//      pick up the persistent IPv4-only renderer behaviour.
//
// Pure: each function takes `.env` text in, returns the new text +
// a Change descriptor describing what (if anything) was rewritten.
// I/O happens in the caller (operator/update.ts).

export interface EnvChange {
  readonly phase:
    | "panel-domain-backfill"
    | "panel-domain-relocate"
    | "app-url-fix"
    | "singbox-direct-defaults";
  readonly summary: string;
}

export interface EnvMigrationResult {
  readonly content: string;
  readonly changes: readonly EnvChange[];
  // Set when phase 1 wanted to act but couldn't (DOMAIN missing).
  readonly warning?: string;
}

const DOMAIN_LINE_RE = /^DOMAIN=(.*)$/m;
const PANEL_DOMAIN_LINE_RE = /^PANEL_DOMAIN=(.*)$/m;
const SINGBOX_DIRECT_DOMAIN_STRATEGY_RE = /^SINGBOX_DIRECT_DOMAIN_STRATEGY=/m;
const SINGBOX_DIRECT_CONNECT_TIMEOUT_RE = /^SINGBOX_DIRECT_CONNECT_TIMEOUT=/m;
const SINGBOX_DIRECT_FALLBACK_DELAY_RE = /^SINGBOX_DIRECT_FALLBACK_DELAY=/m;
const LEGACY_APP_URL_RE = /^(APP_URL=https?:\/\/)\$\{DOMAIN\}/m;
// "non-comment line that references ${PANEL_DOMAIN}" — comments
// start with optional whitespace then '#'. Used in phase 2.
const PANEL_DOMAIN_REF_RE = /\$\{PANEL_DOMAIN\}/;

function extractDomain(content: string): string | null {
  const m = content.match(DOMAIN_LINE_RE);
  if (!m) return null;
  const raw = m[1] ?? "";
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

// ---------- Phase 1: backfill ----------

export function backfillPanelDomain(content: string): {
  content: string;
  change: EnvChange | null;
  warning?: string;
} {
  if (PANEL_DOMAIN_LINE_RE.test(content)) {
    return { content, change: null };
  }
  const domain = extractDomain(content);
  if (!domain) {
    return {
      content,
      change: null,
      warning: "DOMAIN missing in .env — cannot auto-derive PANEL_DOMAIN; manual fix required",
    };
  }
  const derived = `panel.${domain}`;
  // Insert immediately after the DOMAIN= line.
  const lines = content.split("\n");
  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    out.push(line);
    if (!inserted && /^DOMAIN=/.test(line)) {
      out.push("# v0.0.54 auto-migration — PANEL_DOMAIN added (was missing in pre-v0.0.33 .env)");
      out.push(`PANEL_DOMAIN=${derived}`);
      inserted = true;
    }
  }
  return {
    content: out.join("\n"),
    change: {
      phase: "panel-domain-backfill",
      summary: `added PANEL_DOMAIN=${derived} after DOMAIN= in .env`,
    },
  };
}

// ---------- Phase 2: relocate ----------

// Find first non-comment line that references ${PANEL_DOMAIN}.
// Returns the 1-based line number or 0 when none.
export function firstPanelDomainRefLine(content: string): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*#/.test(l)) continue;
    if (PANEL_DOMAIN_REF_RE.test(l)) return i + 1;
  }
  return 0;
}

// Find the 1-based line number of the PANEL_DOMAIN= definition, or 0.
export function panelDomainDefLine(content: string): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^PANEL_DOMAIN=/.test(lines[i]!)) return i + 1;
  }
  return 0;
}

export function relocatePanelDomain(content: string): {
  content: string;
  change: EnvChange | null;
} {
  const defLine = panelDomainDefLine(content);
  const refLine = firstPanelDomainRefLine(content);
  if (defLine === 0 || refLine === 0 || defLine <= refLine) {
    return { content, change: null };
  }
  // Definition is AFTER first ref → relocate. Strip the existing
  // PANEL_DOMAIN= line(s); re-insert immediately after the
  // DOMAIN= line.
  const defM = content.match(PANEL_DOMAIN_LINE_RE);
  if (!defM) return { content, change: null };
  const value = defM[1] ?? "";
  const lines = content.split("\n");
  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (/^PANEL_DOMAIN=/.test(line)) continue;
    out.push(line);
    if (!inserted && /^DOMAIN=/.test(line)) {
      out.push(`PANEL_DOMAIN=${value}`);
      inserted = true;
    }
  }
  return {
    content: out.join("\n"),
    change: {
      phase: "panel-domain-relocate",
      summary: `relocated PANEL_DOMAIN to precede \${PANEL_DOMAIN} reference (was line ${defLine}, ref at line ${refLine})`,
    },
  };
}

// ---------- Phase 3: APP_URL fix ----------

export function fixLegacyAppUrl(content: string): { content: string; change: EnvChange | null } {
  if (!LEGACY_APP_URL_RE.test(content)) {
    return { content, change: null };
  }
  const replaced = content.replace(LEGACY_APP_URL_RE, "$1${PANEL_DOMAIN}");
  return {
    content: replaced,
    change: {
      phase: "app-url-fix",
      summary: "APP_URL legacy form (${DOMAIN}) corrected to ${PANEL_DOMAIN}",
    },
  };
}

// ---------- Phase 4: sing-box direct outbound defaults ----------

export function backfillSingboxDirectDefaults(content: string): {
  content: string;
  change: EnvChange | null;
} {
  const canonical = content.replace(
    /^SINGBOX_DIRECT_DOMAIN_STRATEGY=prefer_ipv4$/m,
    "SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only",
  );
  const strategyCanonicalized = canonical !== content;
  content = canonical;

  if (
    SINGBOX_DIRECT_DOMAIN_STRATEGY_RE.test(content) &&
    SINGBOX_DIRECT_CONNECT_TIMEOUT_RE.test(content) &&
    SINGBOX_DIRECT_FALLBACK_DELAY_RE.test(content)
  ) {
    return {
      content,
      change: strategyCanonicalized
        ? {
            phase: "singbox-direct-defaults",
            summary: "changed sing-box direct outbound strategy from prefer_ipv4 to ipv4_only",
          }
        : null,
    };
  }
  const additions = ["", "# v0.4.17 auto-migration — sing-box direct outbound IPv4-only policy"];
  if (!SINGBOX_DIRECT_DOMAIN_STRATEGY_RE.test(content)) {
    additions.push("SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only");
  }
  if (!SINGBOX_DIRECT_CONNECT_TIMEOUT_RE.test(content)) {
    additions.push("SINGBOX_DIRECT_CONNECT_TIMEOUT=2s");
  }
  if (!SINGBOX_DIRECT_FALLBACK_DELAY_RE.test(content)) {
    additions.push("SINGBOX_DIRECT_FALLBACK_DELAY=100ms");
  }
  const block = additions.join("\n");
  return {
    content: content.endsWith("\n") ? `${content}${block.slice(1)}\n` : `${content}${block}\n`,
    change: {
      phase: "singbox-direct-defaults",
      summary: strategyCanonicalized
        ? "changed sing-box direct outbound strategy to ipv4_only and added missing defaults"
        : "added sing-box direct outbound IPv4-only defaults to .env",
    },
  };
}

// ---------- Migration composer ----------

// Run all phases in order on a .env body. Each phase is
// idempotent — a no-op on already-canonical input.
export function migrateEnv(content: string): EnvMigrationResult {
  const changes: EnvChange[] = [];
  let warning: string | undefined;
  let cur = content;

  const p1 = backfillPanelDomain(cur);
  cur = p1.content;
  if (p1.change) changes.push(p1.change);
  if (p1.warning) warning = p1.warning;

  const p2 = relocatePanelDomain(cur);
  cur = p2.content;
  if (p2.change) changes.push(p2.change);

  const p3 = fixLegacyAppUrl(cur);
  cur = p3.content;
  if (p3.change) changes.push(p3.change);

  const p4 = backfillSingboxDirectDefaults(cur);
  cur = p4.content;
  if (p4.change) changes.push(p4.change);

  return { content: cur, changes, warning };
}
