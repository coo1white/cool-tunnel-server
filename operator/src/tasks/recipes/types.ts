// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/types.ts — shared Recipe interface.
//
// Same shape as fix.ts's delegating recipes; pure-TS recipes implement
// this directly. `describe` takes a RunContext so a recipe can probe
// the live system and produce a context-aware explanation (e.g.
// listing the specific missing services for compose_service_down).

import type { RunContext } from "../../runner/context";

export interface Recipe {
    readonly slug: string;
    describe(ctx: RunContext): Promise<string>;
    detect(ctx: RunContext): Promise<boolean>;
    fix(ctx: RunContext): Promise<{ ok: boolean; detail?: string }>;
    verify(ctx: RunContext): Promise<boolean>;
}
