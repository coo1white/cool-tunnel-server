// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/verify-supervisord.test.ts — supervisord.conf
// lifecycle-invariants drift detector.

import { test, expect } from "bun:test";
import { verify } from "../verify-supervisord";

const ALL_FOUR = `
stopsignal = TERM
stopwaitsecs = 20
killasgroup = true
stopasgroup = true
`;

test("verify finds zero programs in an empty file", () => {
    const r = verify("");
    expect(r.programs).toEqual([]);
    expect(r.failures).toEqual([]);
});

test("verify passes a complete Bun admin block", () => {
    const conf = `
[program:ct-admin]
command = bun run /opt/cool-tunnel/operator/src/index.ts admin serve
${ALL_FOUR}
`;
    const r = verify(conf);
    expect(r.programs).toEqual(["ct-admin"]);
    expect(r.failures).toEqual([]);
});

test("verify flags a missing required attribute", () => {
    const conf = `
[program:queue]
command = bun run worker
stopsignal = TERM
stopwaitsecs = 20
killasgroup = true
`;
    // missing stopasgroup
    const r = verify(conf);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("[queue]");
    expect(r.failures[0]).toContain("stopasgroup");
});

test("verify does not require program-specific attributes", () => {
    const conf = `
[program:queue]
command = bun run worker
${ALL_FOUR}
`;
    const r = verify(conf);
    expect(r.failures).toEqual([]);
});

test("verify discovers all [program:*] blocks without a maintained list", () => {
    const conf = `
[supervisord]
nodaemon = true

[program:ct-admin]
command = bun run /opt/cool-tunnel/operator/src/index.ts admin serve
${ALL_FOUR}

[program:queue]
command = bun run worker
${ALL_FOUR}

[program:scheduler]
command = bun run scheduler
${ALL_FOUR}

[program:ct-core-daemon]
command = /usr/local/bin/ct-server-core daemon
${ALL_FOUR}
`;
    const r = verify(conf);
    expect(r.programs).toEqual([
        "ct-admin",
        "queue",
        "scheduler",
        "ct-core-daemon",
    ]);
    expect(r.failures).toEqual([]);
});

test("verify ignores commented-out attribute lines", () => {
    const conf = `
[program:queue]
command = bun run worker
# stopsignal = TERM
stopwaitsecs = 20
killasgroup = true
stopasgroup = true
`;
    const r = verify(conf);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("stopsignal");
});

test("verify stops a block at the next [section] header", () => {
    const conf = `
[program:queue]
command = bun run worker
${ALL_FOUR}

[supervisorctl]
serverurl = unix:///tmp/supervisor.sock

[program:scheduler]
command = bun run scheduler
stopsignal = TERM
stopwaitsecs = 20
killasgroup = true
`;
    // scheduler is missing stopasgroup; queue is fine.
    const r = verify(conf);
    expect(r.programs).toEqual(["queue", "scheduler"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("[scheduler]");
    expect(r.failures[0]).toContain("stopasgroup");
});
