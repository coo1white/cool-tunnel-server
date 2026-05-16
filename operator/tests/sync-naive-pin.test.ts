// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/sync-naive-pin.test.ts — pure-logic tests for the
// canonical-pin → Dockerfile ARG rewriter.

import { test, expect } from "bun:test";
import {
    argLineRe,
    planNaiveSync,
    rewriteArg,
    validatePin,
    type NaivePin,
} from "../sync-naive-pin";

const PIN: NaivePin = {
    upstream_tag: "v148.0.7778.96-5",
    assets: {
        "linux-x64": {
            url: "https://example.test/naive-x64.tar.xz",
            sha256: "a".repeat(64),
        },
        "linux-arm64": {
            url: "https://example.test/naive-arm64.tar.xz",
            sha256: "b".repeat(64),
        },
    },
};

// ---------- argLineRe ----------

test("argLineRe matches `ARG NAME=value` at start of line", () => {
    const re = argLineRe("NAIVE_VERSION");
    const m = re.exec("ARG NAIVE_VERSION=v148.0.7778.96-5");
    expect(m).not.toBeNull();
    expect(m![2]).toBe("v148.0.7778.96-5");
});

test("argLineRe rejects ARG without `=` (no default)", () => {
    const re = argLineRe("TARGETARCH");
    expect(re.test("ARG TARGETARCH")).toBe(false);
});

test("argLineRe is anchored — doesn't match inside RUN blocks", () => {
    const re = argLineRe("NAIVE_VERSION");
    expect(re.test('RUN echo "ARG NAIVE_VERSION=foo"')).toBe(false);
    expect(re.test("  ARG NAIVE_VERSION=v1")).toBe(false);
});

test("argLineRe doesn't bleed across similar names", () => {
    const re = argLineRe("NAIVE_VERSION");
    expect(re.test("ARG NAIVE_VERSION_OLD=v1")).toBe(false);
});

// ---------- rewriteArg ----------

test("rewriteArg returns before-value + replaced body", () => {
    const body = "FROM x\nARG NAIVE_VERSION=v1.0.0-1\nRUN echo hi\n";
    const r = rewriteArg(body, "NAIVE_VERSION", "v2.0.0-3");
    expect(r.before).toBe("v1.0.0-1");
    expect(r.content).toBe("FROM x\nARG NAIVE_VERSION=v2.0.0-3\nRUN echo hi\n");
});

test("rewriteArg is a no-op when already in sync (before == want)", () => {
    const body = "ARG NAIVE_VERSION=v2.0.0-3\n";
    const r = rewriteArg(body, "NAIVE_VERSION", "v2.0.0-3");
    expect(r.before).toBe("v2.0.0-3");
    expect(r.content).toBe(body);
});

test("rewriteArg throws if the ARG is absent (no silent no-op)", () => {
    expect(() => rewriteArg("FROM x\nRUN echo hi\n", "NAIVE_VERSION", "v1")).toThrow(
        /ARG NAIVE_VERSION/,
    );
});

// ---------- planNaiveSync ----------

const NAIVE_DF = [
    "FROM alpine:3.21 AS fetch",
    "ARG NAIVE_TAG=v0.0.0-0",
    "ARG NAIVE_URL=https://old/url.tar.xz",
    "ARG NAIVE_SHA256=000000000000000000000000000000000000000000000000000000000000dead",
    "RUN curl -O $NAIVE_URL",
].join("\n");

const PANEL_DF = [
    "FROM frankenphp:1",
    "ARG TARGETARCH",
    "ARG NAIVE_VERSION=v0.0.0-0",
    "ARG NAIVE_SHA256_AMD64=000000000000000000000000000000000000000000000000000000000000beef",
    "ARG NAIVE_SHA256_ARM64=000000000000000000000000000000000000000000000000000000000000cafe",
    "RUN echo $NAIVE_VERSION",
].join("\n");

test("planNaiveSync reports drift for every misaligned ARG", () => {
    const p = planNaiveSync(PIN, NAIVE_DF, PANEL_DF);
    // 3 naive + 3 panel = 6 fields, all out of sync.
    expect(p.drift.length).toBe(6);
});

test("planNaiveSync rewrites both Dockerfiles to the canonical values", () => {
    const p = planNaiveSync(PIN, NAIVE_DF, PANEL_DF);
    expect(p.naiveOut).toContain("ARG NAIVE_TAG=v148.0.7778.96-5");
    expect(p.naiveOut).toContain(`ARG NAIVE_SHA256=${"a".repeat(64)}`);
    expect(p.panelOut).toContain("ARG NAIVE_VERSION=v148.0.7778.96-5");
    expect(p.panelOut).toContain(`ARG NAIVE_SHA256_AMD64=${"a".repeat(64)}`);
    expect(p.panelOut).toContain(`ARG NAIVE_SHA256_ARM64=${"b".repeat(64)}`);
});

test("planNaiveSync drift is empty when already in lockstep", () => {
    const aligned = planNaiveSync(PIN, NAIVE_DF, PANEL_DF);
    const r = planNaiveSync(PIN, aligned.naiveOut, aligned.panelOut);
    expect(r.drift.length).toBe(0);
});

test("planNaiveSync throws (loud, not silent) if an ARG line is missing", () => {
    const broken = NAIVE_DF.replace("ARG NAIVE_URL=", "ARG NAIVE_URL_RENAMED=");
    expect(() => planNaiveSync(PIN, broken, PANEL_DF)).toThrow(/ARG NAIVE_URL/);
});

// ---------- validatePin ----------

test("validatePin accepts a well-formed pin", () => {
    expect(() => validatePin(PIN)).not.toThrow();
});

test("validatePin rejects missing upstream_tag", () => {
    const bad = { ...PIN, upstream_tag: undefined };
    expect(() => validatePin(bad)).toThrow(/upstream_tag/);
});

test("validatePin rejects upstream_tag without leading 'v'", () => {
    const bad = { ...PIN, upstream_tag: "148.0.7778.96-5" };
    expect(() => validatePin(bad)).toThrow(/upstream_tag/);
});

test("validatePin rejects short SHA", () => {
    const bad = {
        ...PIN,
        assets: { ...PIN.assets, "linux-x64": { url: PIN.assets["linux-x64"].url, sha256: "abc" } },
    };
    expect(() => validatePin(bad)).toThrow(/sha256/);
});

test("validatePin rejects http:// URL (require https)", () => {
    const bad = {
        ...PIN,
        assets: {
            ...PIN.assets,
            "linux-x64": { url: "http://example.test/x.tar.xz", sha256: "a".repeat(64) },
        },
    };
    expect(() => validatePin(bad)).toThrow(/https/);
});

test("validatePin requires both arches", () => {
    const bad = { upstream_tag: "v1-1", assets: { "linux-x64": PIN.assets["linux-x64"] } };
    expect(() => validatePin(bad)).toThrow(/linux-arm64/);
});
