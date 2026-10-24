import app from './app.js';
import config from './config/index.js';
import prisma from './db/prisma.js';

const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`API listening on http://${config.server.host}:${config.server.port} (${config.env})`);
    console.log(`Health check: http://localhost:${config.server.port}/api/health`);
});

// Surface database connectivity problems at boot instead of on the first request.
prisma
    .$connect()
    .then(() => console.log('Database connection established'))
    .catch((error) => {
        console.error('Database connection failed:', error.message);
        process.exitCode = 1;
        server.close();
    });

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
