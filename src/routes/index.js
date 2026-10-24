import express from 'express';
import authRoutes from './auth.routes.js';
import customerRoutes from './customer.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import invoiceRoutes from './invoice.routes.js';
import productRoutes from './product.routes.js';
import reportRoutes from './report.routes.js';

const router = express.Router();

/**
 * GET /api/health
 * Liveness probe. Does not touch the database so it stays cheap.
 */
router.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            status: 'ok',
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
        },
    });
});

router.use('/auth', authRoutes);
router.use('/customers', customerRoutes);
router.use('/products', productRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/reports', reportRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
