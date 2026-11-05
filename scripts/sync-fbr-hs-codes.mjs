/**
 * Script to sync FBR HS codes from the reference endpoint.
 * 
 * Usage: node scripts/sync-fbr-hs-codes.mjs
 * 
 * This script calls the FBR reference endpoint to synchronize
 * HS codes into the FbrHsCode database table.
 * 
 * Requires FBR_BASE_URL and FBR_TOKEN environment variables.
 */
import { PrismaClient } from '@prisma/client';
import './config/env.js';

const prisma = new PrismaClient();

const FBR_BASE_URL = process.env.FBR_BASE_URL;
const FBR_TOKEN = process.env.FBR_TOKEN;

if (!FBR_TOKEN) {
    console.error('Error: FBR_TOKEN environment variable is not set.');
    console.error('FBR reference data not configured. Cannot sync HS codes.');
    process.exit(1);
}

if (!FBR_BASE_URL) {
    console.error('Error: FBR_BASE_URL environment variable is not set.');
    process.exit(1);
}

import '@domainx/fetch';

async function syncHsCodes() {
    const fetch = await import('@domainx/fetch');
    const fetchInstance = fetch.createFetch({
        baseUrl: FBR_BASE_URL,
        headers: {
            'Authorization': `Bearer ${FBR_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });

    try {
        const response = await fetchInstance.get('/pdi/v1/itemdesccode');
        const hsCodes = response.data;

        console.log(`Received ${hsCodes.length} HS codes from FBR reference endpoint`);

        // Upsert each HS code into the database
        for (const hsCode of hsCodes) {
            await prisma.fbrHsCode.upsert({
                where: { hsCode: hsCode.hsCode },
                update: {
                    description: hsCode.description,
                    updatedAt: new Date(),
                },
                create: {
                    hsCode: hsCode.hsCode,
                    description: hsCode.description,
                    updatedAt: new Date(),
                },
            });
        }

        console.log(`Successfully synced ${hsCodes.length} HS codes to FbrHsCode table`);
    } catch (error) {
        console.error('Error syncing HS codes:', error.message);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

syncHsCodes();