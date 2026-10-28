import ApiError from '../utils/ApiError.js';
import prisma from '../db/prisma.js';
import { missingPermission, ROLES } from '../utils/permissions.js';

/**
 * Loads the authenticated user from the database and attaches the identity
 * that every document records as "Prepared by".
 *
 * The role, display name and email always come from the verified session's
 * user row — never from anything the client submitted — so a forged
 * `createdBy`/`role` field in the request body can never escalate privileges
 * or impersonate another user.
 */
export async function loadActor(req, res, next) {
    try {
        const userId = Number(req.user?.sub);
        if (!Number.isSafeInteger(userId) || userId < 1) {
            throw ApiError.unauthorized('Invalid authenticated user');
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, fullName: true, email: true, role: true },
        });
        if (!user) throw ApiError.unauthorized('Account no longer exists');

        req.actor = {
            id: user.id,
            fullName: user.fullName,
            email: user.email,
            role: ROLES.includes(user.role) ? user.role : 'sales',
        };
        return next();
    } catch (error) {
        return next(error);
    }
}

/**
 * Gate for a single permission from utils/permissions.js.
 * Applied on the route *and* re-checked inside the service before any
 * financial mutation, so authorisation does not depend on the UI.
 */
export function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.actor) {
            return next(ApiError.unauthorized('Authentication required'));
        }
        const missing = missingPermission(req.actor.role, permission);
        if (missing) {
            return next(
                ApiError.forbidden(
                    `Your role "${req.actor.role}" is not permitted to perform this action (${permission}).`
                )
            );
        }
        return next();
    };
}

/** Convenience gate when several permissions are equivalent. */
export function requireAnyPermission(...permissions) {
    return (req, res, next) => {
        if (!req.actor) {
            return next(ApiError.unauthorized('Authentication required'));
        }
        const allowed = permissions.some((permission) => !missingPermission(req.actor.role, permission));
        if (!allowed) {
            return next(
                ApiError.forbidden(
                    `Your role "${req.actor.role}" is not permitted to perform this action.`
                )
            );
        }
        return next();
    };
}

export default requirePermission;
