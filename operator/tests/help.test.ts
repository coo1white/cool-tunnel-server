// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/help.test.ts — topic registry shape + render
// helpers from operator/help.ts.

import { expect, test } from "bun:test";
import { renderTopic, renderTopicList, TOPIC_SLUGS, TOPICS } from "../help";

test("TOPIC_SLUGS covers the currently implemented ct help topics", () => {
  expect(TOPIC_SLUGS).toEqual([
    "getting-started",
    "install",
    "update",
    "doctor",
    "auto-update",
    "backup",
    "restore",
    "troubleshooting",
  ]);
});

test("every topic has a non-empty title and body", () => {
  for (const slug of TOPIC_SLUGS) {
    const t = TOPICS[slug]!;
    expect(t.title.length).toBeGreaterThan(0);
    expect(t.body.length).toBeGreaterThan(0);
  }
});

test("renderTopic on a known slug includes the title", () => {
  const r = renderTopic("install");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.output).toContain(TOPICS.install!.title);
});

test("renderTopic on a known slug includes the body", () => {
  const r = renderTopic("doctor");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.output).toContain("PASS / WARN / FAIL");
});

test("renderTopic on an unknown slug reports the error", () => {
  const r = renderTopic("bogus");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("bogus");
});

test("renderTopicList enumerates every slug", () => {
  const out = renderTopicList();
  for (const slug of TOPIC_SLUGS) {
    expect(out).toContain(slug);
  }
});
