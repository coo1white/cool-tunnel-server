// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice, PermissionDenied, StatusPill } from "../src/components";

test("Notice renders nothing when there is no message", () => {
  expect(renderToStaticMarkup(<Notice />)).toBe("");
  expect(renderToStaticMarkup(<Notice state={{ ok: true, message: "" }} />)).toBe("");
});

test("Notice surfaces a failed action message with the error class", () => {
  const html = renderToStaticMarkup(<Notice state={{ ok: false, message: "Password must be at least 12 characters." }} />);
  expect(html).toContain("Password must be at least 12 characters.");
  expect(html).toContain('class="notice error"');
});

test("Notice marks a successful action with the info class", () => {
  const html = renderToStaticMarkup(<Notice state={{ ok: true, message: "Settings saved." }} />);
  expect(html).toContain("Settings saved.");
  expect(html).toContain('class="notice info"');
});

test("Notice escapes HTML in the message (no injection from API errors)", () => {
  const html = renderToStaticMarkup(<Notice state={{ ok: false, message: "<img src=x onerror=alert(1)>" }} />);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("StatusPill encodes the value into its class and text", () => {
  expect(renderToStaticMarkup(<StatusPill value="active" />)).toBe('<span class="status active">active</span>');
});

test("PermissionDenied shows the default and custom messages", () => {
  expect(renderToStaticMarkup(<PermissionDenied />)).toContain("Your role cannot use this action.");
  expect(renderToStaticMarkup(<PermissionDenied message="Read only." />)).toContain("Read only.");
});
