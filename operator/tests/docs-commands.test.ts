// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/docs-commands.test.ts — user-facing command drift checks.

import { test, expect } from "bun:test";

const LATEST_RELEASE_LINE =
    `LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"`;
const BREW_STYLE_BOOTSTRAP =
    `BRANCH="\${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/\${LATEST}/scripts/bootstrap.sh")"`;
const PIPE_TO_BASH_BOOTSTRAP =
    "curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash";

test("quickstart docs use the release-pinned Homebrew-style bootstrap command", async () => {
    for (const path of ["README.md", "GETTING_STARTED.md", "docs/test-vps.md"]) {
        const text = await Bun.file(`../${path}`).text();
        expect(text).toContain(LATEST_RELEASE_LINE);
        expect(text).toContain(BREW_STYLE_BOOTSTRAP);
        expect(text).not.toContain(PIPE_TO_BASH_BOOTSTRAP);
    }
});

test("bootstrap script advertises and explains the Homebrew-style flow", async () => {
    const text = await Bun.file("../scripts/bootstrap.sh").text();
    expect(text).toContain(LATEST_RELEASE_LINE);
    expect(text).toContain(BREW_STYLE_BOOTSTRAP);
    expect(text).toContain("Cool Tunnel Server bootstrap will:");
    expect(text).toContain("Press RETURN/ENTER to continue");
});
