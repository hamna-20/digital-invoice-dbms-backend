import bcrypt from 'bcryptjs';
import prisma from '../db/prisma.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { signAccessToken } from '../utils/jwt.js';

/**
 * Fields safe to return to clients. passwordHash is never included.
 */
const publicUserSelect = {
    id: true,
    fullName: true,
    email: true,
    role: true,
    createdAt: true,
};

const toPublicUser = (user) => ({
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
});

/**
 * A bcrypt hash used only to spend a comparable amount of CPU when the email
 * does not exist. Without this, a missing account returns much faster than a
 * wrong password, letting an attacker enumerate registered emails by timing.
 * Computed once, lazily.
 */
let dummyHashPromise;
const getDummyHash = () => {
    dummyHashPromise ??= bcrypt.hash('__no_such_account_timing_guard__', config.security.bcryptRounds);
    return dummyHashPromise;
};

/**
 * Registers a new account.
 * @param {{ fullName: string, email: string, password: string }} input already validated/normalised
 */
export async function signup({ fullName, email, password }) {
    const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
    });

    if (existing) {
        throw ApiError.conflict('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

    try {
        const user = await prisma.user.create({
            data: { fullName, email, passwordHash },
            select: publicUserSelect,
        });

        return { user: toPublicUser(user) };
    } catch (error) {
        // Two concurrent signups can both pass the check above; the unique
        // index is the real guard. Translate it to the same 409.
        if (error?.code === 'P2002') {
            throw ApiError.conflict('An account with this email already exists');
        }
        throw error;
    }
}

/**
 * Verifies credentials and issues an access token.
 * Every failure returns the same generic message so the response cannot be
 * used to tell whether an email is registered.
 * @param {{ email: string, password: string }} input already validated/normalised
 */
export async function signin({ email, password }) {
    const user = await prisma.user.findUnique({ where: { email } });

    const hashToCompare = user?.passwordHash ?? (await getDummyHash());
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    if (!user || !passwordMatches) {
        throw ApiError.unauthorized('Invalid email or password');
    }

    // The token carries the identity only. The role is deliberately NOT put in
    // the token: it is re-read from the database on every request by
    // `loadActor`, so demoting an account takes effect immediately.
    const token = signAccessToken({
        sub: String(user.id),
        email: user.email,
    });

    return {
        token,
        expiresIn: config.jwt.expiresIn,
        user: toPublicUser(user),
    };
}
