// SPDX-License-Identifier: AGPL-3.0-only

import type { AdminRole, ProtocolKey, UserStatus } from "@cool-tunnel/shared";

export interface CreateUserInput {
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  role: AdminRole;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  email?: string;
  username?: string;
  name?: string;
  role?: AdminRole;
  status?: UserStatus;
  mustChangePassword?: boolean;
}

export interface CreateProxyAccountInput {
  username: string;
  label?: string | null;
  enabled?: boolean;
  clientDefaultLocalPort?: number;
  enabledProtocols?: ProtocolKey[];
  expiresAt?: string | null;
}

export interface UpdateProxyAccountInput extends Partial<CreateProxyAccountInput> {}
