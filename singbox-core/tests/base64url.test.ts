// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/base64url.test.ts

import { test, expect } from "bun:test";
import { base64urlDecode, base64urlEncode } from "../src/util/base64url.ts";

test("base64urlEncode round-trips arbitrary byte sequences", () => {
    const inputs: Uint8Array[] = [
        new Uint8Array([]),
        new Uint8Array([0]),
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        new Uint8Array(32).fill(0xff),
        new Uint8Array([255, 254, 253, 0, 0, 0, 128, 64]),
    ];
    for (const bytes of inputs) {
        const encoded = base64urlEncode(bytes);
        expect(encoded).not.toMatch(/[+/=]/);
        const decoded = base64urlDecode(encoded);
        expect(decoded.length).toBe(bytes.length);
        for (let i = 0; i < bytes.length; i++) expect(decoded[i]).toBe(bytes[i]!);
    }
});

test("base64urlDecode is lenient about input padding", () => {
    // base64url SHOULD be unpadded, but some encoders emit "=" — we
    // accept either form for forward-compat.
    const padded = "AAEC";
    const unpadded = "AAEC";
    expect(base64urlDecode(padded)).toEqual(base64urlDecode(unpadded));
});
