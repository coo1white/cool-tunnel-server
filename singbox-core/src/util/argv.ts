// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/util/argv.ts — tiny strict argv helpers.

export function flagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function integerFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  opts: { min: number; max?: number },
): number {
  const raw = flagValue(argv, index, flag);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be an integer`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < opts.min ||
    (opts.max !== undefined && value > opts.max)
  ) {
    const bound = opts.max === undefined ? `>= ${opts.min}` : `between ${opts.min} and ${opts.max}`;
    throw new Error(`${flag} must be ${bound}`);
  }
  return value;
}
