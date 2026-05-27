// SPDX-License-Identifier: AGPL-3.0-only

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
