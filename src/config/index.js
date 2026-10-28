import 'dotenv/config';

/**
 * Centralised, validated application configuration.
 * Fails fast at startup when a required value is missing so the process
 * never runs in a half-configured state.
 */

const toInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const required = (name, value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        throw new Error(
            `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`
        );
    }
    return value;
};

const env = process.env.NODE_ENV || 'development';

const config = {
    env,
    isProduction: env === 'production',

    server: {
        port: toInt(process.env.PORT, 5000),
        host: process.env.HOST || '0.0.0.0',
    },

    db: {
        url: required('DATABASE_URL', process.env.DATABASE_URL),
    },

    jwt: {
        secret: required('JWT_SECRET', process.env.JWT_SECRET),
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
        issuer: process.env.JWT_ISSUER || 'digital-invoice-api',
        audience: process.env.JWT_AUDIENCE || 'digital-invoice-web',
    },

    security: {
        bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
        corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
        authRateLimit: {
            windowMs: 15 * 60 * 1000,
            max: toInt(process.env.AUTH_RATE_LIMIT_MAX, env === 'production' ? 20 : 100),
        },
    },
};

// A short secret makes HS256 tokens guessable, so refuse to start in production.
if (config.isProduction && config.jwt.secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long in production.');
}

export default config;
