import app from './app.js';
import config from './config/index.js';
import prisma from './db/prisma.js';

const server = app.listen(config.server.port, config.server.host);

let shuttingDown = false;

const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    server.close(async () => {
        try {
            await prisma.$disconnect();
            console.log('Shutdown complete');
            process.exit(0);
        } catch (error) {
            console.error('Error during shutdown:', error.message);
            process.exit(1);
        }
    });

    // Don't hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
};

// Only announce success once the socket is actually accepting connections.
// (Express 5 also forwards bind failures to the listen callback, so relying on
// the callback alone can print a false "listening" banner and exit silently.)
server.on('listening', () => {
    console.log(`API listening on http://${config.server.host}:${config.server.port} (${config.env})`);
    console.log(`Health check: http://localhost:${config.server.port}/api/health`);
});

server.on('error', (error) => {
    // Runtime error on an already-open server: report it, keep serving.
    if (server.listening) {
        console.error('HTTP server error:', error.message);
        return;
    }

    // Startup error: the port could not be bound, so npm must not look healthy.
    console.error(
        `Failed to start API on http://${config.server.host}:${config.server.port}: ${error.message}`
    );

    if (error.code === 'EADDRINUSE') {
        const alternativePort = config.server.port + 1;
        console.error(
            `Port ${config.server.port} is already in use - another copy of the API is probably running.\n` +
                'Stop that process, or start this one on a different port:\n' +
                `  PowerShell: $env:PORT=${alternativePort}; npm start\n` +
                `  CMD:        set PORT=${alternativePort} && npm start`
        );
    }

    process.exitCode = 1;
    // Release the database pool so the process exits instead of hanging.
    prisma
        .$disconnect()
        .catch((disconnectError) => {
            console.error('Error during shutdown:', disconnectError.message);
        })
        .finally(() => process.exit(1));
});

// Surface database connectivity problems at boot instead of on the first request.
prisma
    .$connect()
    .then(() => console.log('Database connection established'))
    .catch((error) => {
        console.error('Database connection failed:', error.message);
        process.exitCode = 1;
        server.close();
        prisma.$disconnect().catch(() => {});
    });

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
});

export default server;
