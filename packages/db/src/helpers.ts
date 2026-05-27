// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_PROTOCOL_KEYS } from "@cool-tunnel/shared";
import type { ProtocolKey } from "@cool-tunnel/shared";

export function normalizeProtocols(value: unknown): ProtocolKey[] {
  let raw: unknown = value;
  const rawString = raw;
  if (typeof rawString === "string") {
    try {
      raw = JSON.parse(rawString) as unknown;
    } catch {
      raw = rawString.split(",");
    }
  }
  if (!Array.isArray(raw)) return [...DEFAULT_PROTOCOL_KEYS];
  const protocols = raw.filter((item): item is ProtocolKey => item === "vless_reality");
  return protocols.length > 0 ? protocols : [...DEFAULT_PROTOCOL_KEYS];
}

export function normalizeJsonStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(",").map((part) => part.trim());
    }
  }
  return [""];
}
