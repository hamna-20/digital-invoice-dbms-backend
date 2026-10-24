import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import config from './config/index.js';
import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';

const app = express();

// Don't advertise the framework.
app.disable('x-powered-by');

// Security headers.
app.use(helmet());

// CORS: only the configured frontend origins may call the API from a browser.
app.use(
    cors({
        origin(origin, callback) {
            // Requests without an Origin (curl, health checks, same-origin) are allowed.
            if (!origin || config.security.corsOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: false,
        maxAge: 600,
    })
);

// Body parsing with a modest cap - auth payloads are tiny.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// All API routes live under /api (includes GET /api/health).
app.use('/api', routes);

// 404 then the single error handler (must be last).
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
