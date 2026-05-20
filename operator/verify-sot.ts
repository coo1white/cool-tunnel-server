// SPDX-License-Identifier: AGPL-3.0-only
// Cross-language SoT parity guard for the panel-domain resolver.

type Mode = "host" | "vps";

type Fixture = {
    name: string;
    panelDomain: string;
    domain: string;
    expect: string | null;
};

type RunResult = {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
};

function processEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }
    return env;
}

const fixtures: Fixture[] = [
    {
        name: "explicit PANEL_DOMAIN wins",
        panelDomain: "admin.example.com",
        domain: "proxy.example.com",
        expect: "admin.example.com",
    },
    {
        name: "DOMAIN fallback",
        panelDomain: "",
        domain: "proxy.example.com",
        expect: "panel.proxy.example.com",
    },
    {
        name: "whitespace PANEL_DOMAIN falls back",
        panelDomain: "   \n\t",
        domain: "proxy.example.com",
        expect: "panel.proxy.example.com",
    },
    {
        name: "trim explicit PANEL_DOMAIN",
        panelDomain: "  admin.example.com  \n",
        domain: "proxy.example.com",
        expect: "admin.example.com",
    },
    {
        name: "both empty fail signal",
        panelDomain: "",
        domain: "",
        expect: null,
    },
];

function parseMode(): Mode {
    const arg = process.argv.find((a) => a.startsWith("--mode="));
    const mode = arg?.split("=", 2)[1] ?? "host";
    if (mode !== "host" && mode !== "vps") {
        console.error(`verify-sot: unknown mode '${mode}' (expected host or vps)`);
        process.exit(2);
    }
    return mode;
}

function has(bin: string): boolean {
    return Bun.which(bin) !== null;
}

function withFixtureEnv(f: Fixture): Record<string, string> {
    return {
        ...processEnv(),
        PANEL_DOMAIN: f.panelDomain,
        DOMAIN: f.domain,
        SQLX_OFFLINE: "true",
    };
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<RunResult> {
    const proc = Bun.spawn(cmd, {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { ok: code === 0, code, stdout, stderr };
}

async function hostPhp(f: Fixture): Promise<RunResult> {
    const script = [
        "error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);",
        "chdir('panel');",
        "require 'vendor/autoload.php';",
        "$app = require 'bootstrap/app.php';",
        "$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();",
        "echo (string) config('cool-tunnel.panel_domain');",
    ].join(" ");

    return run(["php", "-d", "display_errors=0", "-r", script], "..", withFixtureEnv(f));
}

async function hostRust(f: Fixture): Promise<RunResult> {
    return run(
        ["cargo", "run", "--quiet", "--locked", "--", "admin", "panel-domain"],
        "../core",
        withFixtureEnv(f),
    );
}

async function vpsPhp(f: Fixture): Promise<RunResult> {
    const script = [
        "error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);",
        "$app = require 'bootstrap/app.php';",
        "$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();",
        "echo (string) config('cool-tunnel.panel_domain');",
    ].join(" ");

    return run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "-e",
            `PANEL_DOMAIN=${f.panelDomain}`,
            "-e",
            `DOMAIN=${f.domain}`,
            "panel",
            "php",
            "-d",
            "display_errors=0",
            "-r",
            script,
        ],
        "..",
        processEnv(),
    );
}

async function vpsRust(f: Fixture): Promise<RunResult> {
    return run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "-e",
            `PANEL_DOMAIN=${f.panelDomain}`,
            "-e",
            `DOMAIN=${f.domain}`,
            "panel",
            "ct-server-core",
            "admin",
            "panel-domain",
        ],
        "..",
        processEnv(),
    );
}

function normalized(r: RunResult): string {
    return r.stdout.trim();
}

function skip(reason: string): never {
    console.log(`verify-sot: SKIP (${reason})`);
    process.exit(0);
}

async function main(): Promise<void> {
    const mode = parseMode();

    if (mode === "host") {
        if (!has("php")) skip("php not on PATH");
        if (!has("cargo")) skip("cargo not on PATH");
        if (!(await Bun.file("../panel/vendor/autoload.php").exists())) {
            skip("panel/vendor/autoload.php missing; run `cd panel && composer install`");
        }
    } else if (!has("docker")) {
        skip("docker not on PATH");
    }

    const phpRunner = mode === "host" ? hostPhp : vpsPhp;
    const rustRunner = mode === "host" ? hostRust : vpsRust;
    let failures = 0;

    for (const f of fixtures) {
        const [php, rust] = await Promise.all([phpRunner(f), rustRunner(f)]);
        const phpOut = normalized(php);
        const rustOut = normalized(rust);

        if (f.expect === null) {
            const ok = php.ok && phpOut === "" && !rust.ok;
            if (!ok) {
                failures++;
                console.error(
                    `verify-sot: FAIL ${f.name}: expected PHP empty success + Rust fail, got PHP(${php.code})='${phpOut}' Rust(${rust.code})='${rustOut}'`,
                );
            } else {
                console.log(`verify-sot: PASS ${f.name}`);
            }
            continue;
        }

        const ok = php.ok && rust.ok && phpOut === f.expect && rustOut === f.expect;
        if (!ok) {
            failures++;
            console.error(
                `verify-sot: FAIL ${f.name}: expected '${f.expect}', got PHP(${php.code})='${phpOut}' Rust(${rust.code})='${rustOut}'`,
            );
        } else {
            console.log(`verify-sot: PASS ${f.name}`);
        }
    }

    if (failures > 0) {
        console.error(`verify-sot: ${failures} failure(s)`);
        process.exit(1);
    }

    console.log(`verify-sot: all ${fixtures.length} fixtures passed (${mode})`);
}

await main();
