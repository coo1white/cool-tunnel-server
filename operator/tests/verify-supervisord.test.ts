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

test("verify passes a complete frankenphp block", () => {
    const conf = `
[program:frankenphp]
command = /usr/local/bin/frankenphp run --config /etc/caddy-panel/Caddyfile
${ALL_FOUR}
environment = MAX_REQUESTS=500
`;
    const r = verify(conf);
    expect(r.programs).toEqual(["frankenphp"]);
    expect(r.failures).toEqual([]);
});

test("verify flags a missing required attribute", () => {
    const conf = `
[program:queue]
command = php artisan queue:work
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

test("verify flags a missing program-specific attribute on frankenphp", () => {
    const conf = `
[program:frankenphp]
command = /usr/local/bin/frankenphp run
${ALL_FOUR}
`;
    // no MAX_REQUESTS=500
    const r = verify(conf);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("MAX_REQUESTS=500");
});

test("verify does not require MAX_REQUESTS=500 on non-frankenphp programs", () => {
    const conf = `
[program:queue]
command = php artisan queue:work
${ALL_FOUR}
`;
    const r = verify(conf);
    expect(r.failures).toEqual([]);
});

test("verify discovers all [program:*] blocks without a maintained list", () => {
    const conf = `
[supervisord]
nodaemon = true

[program:frankenphp]
command = /usr/local/bin/frankenphp run
${ALL_FOUR}
environment = MAX_REQUESTS=500

[program:queue]
command = php artisan queue:work
${ALL_FOUR}

[program:scheduler]
command = php artisan schedule:work
${ALL_FOUR}

[program:messenger]
command = php artisan messenger:consume
${ALL_FOUR}

[program:ct-core-daemon]
command = /usr/local/bin/ct-server-core daemon
${ALL_FOUR}
`;
    const r = verify(conf);
    expect(r.programs).toEqual([
        "frankenphp",
        "queue",
        "scheduler",
        "messenger",
        "ct-core-daemon",
    ]);
    expect(r.failures).toEqual([]);
});

test("verify ignores commented-out attribute lines", () => {
    const conf = `
[program:queue]
command = php artisan queue:work
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
command = php artisan queue:work
${ALL_FOUR}

[supervisorctl]
serverurl = unix:///tmp/supervisor.sock

[program:scheduler]
command = php artisan schedule:work
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
