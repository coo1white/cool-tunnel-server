// SPDX-License-Identifier: AGPL-3.0-only
// Minimal admin role model. Keep checks close to routes/actions.

export const ADMIN_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type AdminRole = typeof ADMIN_ROLES[number];

const ROLE_RANK: Record<AdminRole, number> = {
    viewer: 10,
    operator: 20,
    admin: 30,
    owner: 40,
};

export function isAdminRole(value: unknown): value is AdminRole {
    return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

export function parseRole(value: unknown): AdminRole | null {
    return isAdminRole(value) ? value : null;
}

export function requireRole(value: unknown): AdminRole {
    const role = parseRole(value);
    if (!role) {
        throw new Error(`invalid role: ${String(value)} (expected one of: ${ADMIN_ROLES.join(", ")})`);
    }
    return role;
}

export function roleAtLeast(actual: AdminRole, minimum: AdminRole): boolean {
    return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export function canManageUsers(role: AdminRole): boolean {
    return role === "owner" || role === "admin";
}

export function canCreateRole(actor: AdminRole, target: AdminRole): boolean {
    if (actor === "owner") return true;
    if (actor !== "admin") return false;
    return target === "operator" || target === "viewer";
}

export function canDeleteRole(actor: AdminRole, target: AdminRole): boolean {
    if (actor === "owner") return true;
    if (actor !== "admin") return false;
    return target === "operator" || target === "viewer";
}

export function canRunAction(role: AdminRole, action: "doctor" | "restart" | "render" | "update" | "logs"): boolean {
    switch (action) {
        case "doctor":
        case "restart":
        case "render":
            return roleAtLeast(role, "operator");
        case "update":
        case "logs":
            return roleAtLeast(role, "admin");
    }
}
