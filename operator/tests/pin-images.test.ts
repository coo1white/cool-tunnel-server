// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/pin-images.test.ts — Dockerfile FROM-line rewriter.

import { expect, test } from "bun:test";
import { fromLineRe, rewriteDockerfile } from "../pin-images";

test("fromLineRe matches a bare FROM <image> line", () => {
  const re = fromLineRe("caddy:2.11.3-alpine");
  expect(re.test("FROM caddy:2.11.3-alpine")).toBe(true);
  expect(re.test("FROM caddy:2.11.3-alpine ")).toBe(true);
});

test("fromLineRe matches FROM <image> AS <stage>", () => {
  const re = fromLineRe("rust:1.88.0-alpine");
  expect(re.test("FROM rust:1.88.0-alpine AS chef")).toBe(true);
  expect(re.test("FROM rust:1.88.0-alpine AS sqlx-prepare")).toBe(true);
});

test("fromLineRe matches an already-pinned line", () => {
  const re = fromLineRe("caddy:2.11.3-alpine");
  expect(re.test("FROM caddy:2.11.3-alpine@sha256:deadbeefcafe")).toBe(true);
  expect(re.test("FROM caddy:2.11.3-alpine@sha256:abc123 AS web")).toBe(true);
});

test("fromLineRe does NOT match a different image with a similar prefix", () => {
  const re = fromLineRe("alpine:3.21");
  // Naive substring matching would let "alpine:3.21-cuda" through;
  // the trailing (@sha256|space|EOL) guard prevents it.
  expect(re.test("FROM alpine:3.21-cuda")).toBe(false);
});

test("fromLineRe does NOT match non-FROM lines", () => {
  const re = fromLineRe("caddy:2.11.3-alpine");
  expect(re.test("# FROM caddy:2.11.3-alpine")).toBe(false);
  expect(re.test("ARG IMAGE=caddy:2.11.3-alpine")).toBe(false);
  expect(re.test("RUN echo caddy:2.11.3-alpine")).toBe(false);
});

test("rewriteDockerfile pins a single FROM line", () => {
  const body = 'FROM caddy:2.11.3-alpine\nCMD ["caddy"]\n';
  const r = rewriteDockerfile(body, "caddy:2.11.3-alpine", "sha256:abc");
  expect(r.changedLines).toBe(1);
  expect(r.content).toBe('FROM caddy:2.11.3-alpine@sha256:abc\nCMD ["caddy"]\n');
});

test("rewriteDockerfile pins multiple FROM lines for the same image", () => {
  const body = [
    "FROM rust:1.88.0-alpine AS chef",
    "FROM chef AS planner",
    "FROM chef AS builder",
    "FROM alpine:3.20 AS runtime",
    "FROM rust:1.88.0-alpine AS sqlx-prepare",
    "",
  ].join("\n");
  const r = rewriteDockerfile(body, "rust:1.88.0-alpine", "sha256:xyz");
  expect(r.changedLines).toBe(2);
  expect(r.content).toContain("FROM rust:1.88.0-alpine@sha256:xyz AS chef");
  expect(r.content).toContain("FROM rust:1.88.0-alpine@sha256:xyz AS sqlx-prepare");
  // Untouched lines stay byte-for-byte identical.
  expect(r.content).toContain("FROM alpine:3.20 AS runtime");
});

test("rewriteDockerfile replaces a previously-pinned digest", () => {
  const oldHex = "deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123";
  const newHex = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const body = `FROM caddy:2.11.3-alpine@sha256:${oldHex} AS web\n`;
  const r = rewriteDockerfile(body, "caddy:2.11.3-alpine", `sha256:${newHex}`);
  expect(r.changedLines).toBe(1);
  expect(r.content).toBe(`FROM caddy:2.11.3-alpine@sha256:${newHex} AS web\n`);
});

test("rewriteDockerfile is a no-op when image not present", () => {
  const body = 'FROM golang:1.22\nCMD ["go"]\n';
  const r = rewriteDockerfile(body, "caddy:2.11.3-alpine", "sha256:abc");
  expect(r.changedLines).toBe(0);
  expect(r.content).toBe(body);
});

test("rewriteDockerfile does not touch a similarly-named image", () => {
  const body = "FROM alpine:3.21-cuda\n";
  const r = rewriteDockerfile(body, "alpine:3.21", "sha256:abc");
  expect(r.changedLines).toBe(0);
  expect(r.content).toBe(body);
});
