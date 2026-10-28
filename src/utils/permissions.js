/**
 * Every authenticated role can perform every application permission.
 *
 * Roles (Users.role, CHECK-constrained in the database):
 *   sales, accounts, manager and admin.
 * The map is the single source of truth. Routes use `requirePermission()`;
 * services re-check the same permission before mutating financial state, so
 * hiding a button in the UI is never the only control.
 */

export const ROLES = ['sales', 'accounts', 'manager', 'admin'];

const EVERY_ROLE = Object.freeze([...ROLES]);

export const PERMISSIONS = {
    'invoice.read': EVERY_ROLE,
    'invoice.create': EVERY_ROLE,
    'invoice.edit_draft': EVERY_ROLE,
    'invoice.issue': EVERY_ROLE,
    'payment.create': EVERY_ROLE,
    'invoice.cancel': EVERY_ROLE,
    'return.create': EVERY_ROLE,
    'return.approve': EVERY_ROLE,
    'return.cancel': EVERY_ROLE,
    'return.settle': EVERY_ROLE,
    'credit.grant': EVERY_ROLE,
    'credit.apply': EVERY_ROLE,
    'credit.reverse': EVERY_ROLE,
    'invoice.void': EVERY_ROLE,
    'user.manage': EVERY_ROLE,
    'audit.read': EVERY_ROLE,
};

/**
 * @param {string} role
 * @param {string} permission key of PERMISSIONS
 * @returns {boolean}
 */
export function can(role, permission) {
    const allowed = PERMISSIONS[permission];
    if (!allowed) throw new Error(`Unknown permission "${permission}"`);
    return allowed.includes(role);
}

/** Throws nothing — returns the missing permission name for a clear 403. */
export function missingPermission(role, permission) {
    return can(role, permission) ? null : permission;
}

export default can;
