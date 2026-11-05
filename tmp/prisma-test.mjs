import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaMssql } from '@prisma/adapter-mssql';

const adapter = new PrismaMssql(process.env.DATABASE_URL, {
  onPoolError(e) { console.error('pool', e?.message ?? e); },
  onConnectionError(e) { console.error('conn', e?.message ?? e); },
});
const prisma = new PrismaClient({ adapter, log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'] });

prisma.$connect()
  .then(() => { console.log('CONNECTED OK'); return prisma.$disconnect(); })
  .catch((e) => {
    console.error('CONNECT ERR', e.message);
    process.exit(1);
  });
