import { PrismaClient } from '@prisma/client';
import { PrismaMssql } from '@prisma/adapter-mssql';
import config from '../config/index.js';

/**
 * Single PrismaClient instance for the whole process.
 *
 * Prisma 7 no longer accepts a datasource URL in schema.prisma nor a
 * `datasourceUrl` option on the client, so a driver adapter is required.
 * The adapter takes the same JDBC-style connection string that the CLI uses
 * (via prisma.config.js), keeping CLI and runtime behaviour identical.
 *
 * @see https://pris.ly/d/prisma7-client-config
 */
const adapter = new PrismaMssql(config.db.url, {
    // Surface connection-level failures through our own logging instead of
    // letting them crash the process silently.
    onPoolError(error) {
        console.error('[prisma] pool error:', error?.message ?? error);
    },
    onConnectionError(error) {
        console.error('[prisma] connection error:', error?.message ?? error);
    },
});

const prisma = new PrismaClient({
    adapter,
    log: config.isProduction ? ['error'] : ['warn', 'error'],
});

export default prisma;
