// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/wire-probe.ts — ct-operator wire-probe task.
//
// Today's incident: a `naive` client binary advertising the right
// `--version` was a build whose Padding-header emission had
// regressed. Every static check passed. The only reliable detector
// is a real wire negotiation. This task spawns naive in client
// mode against the deployment's own upstream, sends a real CONNECT
// through it via curl-over-SOCKS, and reports whether the
// negotiation succeeded.
//
// Inputs (`--` argv):
//   --binary PATH      naive binary to test
//                      (default: `naive`, taken from PATH)
//   --server HOST      naive server hostname to probe against
//                      (default: ${DOMAIN} from .env, e.g.
//                       naive.coolwhite.space)
//   --port PORT        upstream port (default: 443)
//   --username USER    proxy account username
//   --password PW      proxy account cleartext password
//                      (often the password the operator just
//                       rotated to, fed by `./ct drift --json |
//                       jq ...`; never logged)
//   --target HOST      what to fetch through the tunnel
//                      (default: www.google.com:443)
//
// Exit codes:
//   0   wire negotiation succeeded (HTTP 200, padding logged)
//   1   wire negotiation failed (cover-site / missing-padding /
//                                TLS / timeout)
//   2   prerequisites missing (binary not executable, curl
//                              missing, .env missing required
//                              fields, can't bind a temp port)
//
// SECURITY: the password lands in the temp config file at mode
// 0600 in /tmp, removed on exit. It does NOT land in argv (which
// would show up in `ps -ef`) — the spawn passes the config path
// only. Cleartext does NOT appear in this task's stdout/stderr
// or in the JSON output; the report mentions the *outcome* only.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import {
    classifyProbe,
    extractDiagnostic,
    renderProbeLine,
    type ProbeOutcome,
    type ProbeResult,
} from "../util/wire-probe";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Args {
    binary: string;
    server: string;
    port: number;
    username: string;
    password: string;
    target: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Partial<Args> {
    const out: Partial<Args> = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const next = argv[i + 1];
        if (!flag) continue;
        switch (flag) {
            case "--binary":   if (next) { out.binary = next; i++; } break;
            case "--server":   if (next) { out.server = next; i++; } break;
            case "--port":     if (next) { out.port = Number(next); i++; } break;
            case "--username": if (next) { out.username = next; i++; } break;
            case "--password": if (next) { out.password = next; i++; } break;
            case "--target":   if (next) { out.target = next; i++; } break;
        }
    }
    if (out.server === undefined) {
        const dom = (env["DOMAIN"] ?? "").trim();
        if (dom !== "") out.server = dom;
    }
    return out;
}

function defaults(): Pick<Args, "port" | "target" | "binary"> {
    return { port: 443, target: "www.google.com:443", binary: "naive" };
}

// Pick a free localhost port. Bun's `Bun.listen` is convenient
// here because closing it returns the port to the kernel pool
// immediately, unlike a node net.Server.
async function pickFreePort(): Promise<number> {
    const sock = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {}, open() {}, close() {} },
    });
    const port = sock.port;
    sock.stop(true);
    return port;
}

// Wait for naive to bind the SOCKS listener. Polls a non-
// connecting TCP probe rather than parsing stdout — naive's log
// format is one we can't fully rely on (today's incident
// involved a binary whose log format had drifted too).
async function waitForListener(port: number, deadlineMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const sock = await Bun.connect({
                hostname: "127.0.0.1",
                port,
                socket: { data() {}, open() {}, close() {}, error() {} },
            });
            sock.end();
            return true;
        } catch {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    return false;
}

export class WireProbeTask implements Task {
    readonly name = "wire-probe";

    async run(ctx: RunContext): Promise<TaskResult> {
        const cliArgs = parseArgs(process.argv.slice(2), ctx.env);
        const a: Args = { ...defaults(), ...cliArgs } as Args;

        // Validate required.
        const missing: string[] = [];
        if (!a.server) missing.push("--server (or DOMAIN in .env)");
        if (!a.username) missing.push("--username");
        if (!a.password) missing.push("--password");
        if (missing.length > 0) {
            const hint = "usage: ct wire-probe --username U --password PW [--server HOST --port N --binary PATH --target HOST:PORT]";
            process.stderr.write(`error: missing required: ${missing.join(", ")}\n${hint}\n`);
            return {
                ok: false,
                code: 2,
                summary: `missing args: ${missing.join(",")}`,
                skipBridge: true,
            };
        }

        if (!Bun.which("curl")) {
            return { ok: false, code: 2, summary: "curl not on PATH", skipBridge: true };
        }
        if (!Bun.which(a.binary) && !Bun.file(a.binary).size) {
            return {
                ok: false,
                code: 2,
                summary: `naive binary not found: ${a.binary}`,
                skipBridge: true,
            };
        }

        const port = await pickFreePort();
        // 0700 dir to fence the config.json that holds cleartext.
        const tmpDir = mkdtempSync(join(tmpdir(), "ct-wire-probe-"));
        chmodSync(tmpDir, 0o700);
        const configPath = join(tmpDir, "probe.json");
        const probeConfig = {
            listen: `socks://127.0.0.1:${port}`,
            // We deliberately do NOT URL-escape the password
            // because the local naive treats this as a literal
            // URL string and reflects it into Basic-Auth without
            // round-tripping through a parser. Passwords with
            // `@` or `:` in them are a separate audit gap we
            // surface as `--password` rejection here:
            ...(a.password.includes("@") || a.password.includes(":")
                ? { _unsafe: "password contains url-meta; aborting" }
                : {}),
            proxy: `https://${a.username}:${a.password}@${a.server}:${a.port}`,
        };
        if ("_unsafe" in probeConfig) {
            rmSync(tmpDir, { recursive: true, force: true });
            return {
                ok: false,
                code: 2,
                summary: "password contains : or @ — re-rotate to a safer charset before probing",
                skipBridge: true,
            };
        }
        writeFileSync(configPath, JSON.stringify(probeConfig));
        chmodSync(configPath, 0o600);

        const started = Date.now();
        const naive = Bun.spawn([a.binary, configPath], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });

        let stderrAcc = "";
        let httpCode: number | null = null;
        let curlExit = -1;

        try {
            // Pump stderr asynchronously while we wait for the
            // SOCKS listener to come up.
            const stderrReader = (async () => {
                const reader = naive.stderr.getReader();
                const dec = new TextDecoder();
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) stderrAcc += dec.decode(value);
                }
            })();

            const up = await waitForListener(port, 3000);
            if (!up) {
                naive.kill();
                await stderrReader.catch(() => {});
                rmSync(tmpDir, { recursive: true, force: true });
                const result: ProbeResult = {
                    outcome: "naive_didnt_start",
                    ok: false,
                    httpCode: null,
                    elapsedMs: Date.now() - started,
                    diagnostic: extractDiagnostic(stderrAcc),
                };
                return finalize(ctx, result, "naive listener never came up");
            }

            // Real CONNECT via curl. `socks5h://` so the target
            // hostname is resolved by naive (the upstream), not
            // locally — matches real client behaviour.
            const targetUrl = `https://${a.target}`;
            const curl = Bun.spawn(
                [
                    "curl",
                    "-sS",
                    "--max-time",
                    "10",
                    "-x",
                    `socks5h://127.0.0.1:${port}`,
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    targetUrl,
                ],
                { stdout: "pipe", stderr: "pipe" },
            );
            const [curlOut] = await Promise.all([
                new Response(curl.stdout).text(),
                new Response(curl.stderr).text(),
            ]);
            curlExit = (await curl.exited) ?? -1;
            const codeMatch = curlOut.match(/\d{3}/);
            httpCode = codeMatch ? Number(codeMatch[0]) : null;

            naive.kill();
            await stderrReader.catch(() => {});
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }

        const outcome: ProbeOutcome = classifyProbe(stderrAcc, curlExit, httpCode);
        const ok = outcome === "padding_negotiated";
        const result: ProbeResult = {
            outcome,
            ok,
            httpCode,
            elapsedMs: Date.now() - started,
            diagnostic: extractDiagnostic(stderrAcc),
            curlExit,
        };
        return finalize(ctx, result, ok ? "wire OK" : `wire ${outcome}`);
    }
}

function finalize(ctx: RunContext, result: ProbeResult, summary: string): TaskResult {
    if (!ctx.json) {
        process.stdout.write(renderProbeLine(result) + "\n");
        if (!result.ok) {
            process.stdout.write(
                "\nNext steps by outcome:\n" +
                "  missing_padding         → naive binary doesn't emit Padding header.\n" +
                "                            rebuild from upstream NaiveProxy source, or\n" +
                "                            revert to the previously-working binary.\n" +
                "  auth_failure_cover_site → wire works, credentials don't. run `./ct drift`.\n" +
                "  tls_handshake_failed    → cert or SNI mismatch. check caddy ACME + haproxy SNI.\n" +
                "  connect_timeout         → upstream port blackholed. firewall / haproxy down?\n",
            );
        }
    }
    return {
        ok: result.ok,
        code: result.ok ? 0 : 1,
        summary,
        json: result,
        skipBridge: !result.ok,
    };
}
