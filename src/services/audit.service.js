import prisma from '../db/prisma.js';
import { toAmount, toPaisa } from '../utils/money.js';

/**
 * Central audit writer.
 *
 * Every meaningful financial mutation calls `writeAudit` inside the same
 * transaction as the change, so the log can never disagree with the data.
 * The actor's name and email are snapshotted at write time, and the row keeps
 * a `userId` as well, so history survives a later profile change or deletion.
 *
 * Money is passed as integer paisa and stored as DECIMAL(18,2).
 */

/**
 * @param {object|null} tx     Prisma transaction client (or null for the root client).
 * @param {object} entry
 * @param {{id:number, fullName?:string, email?:string}} entry.actor  authenticated user
 * @param {string} entry.action            e.g. 'invoice.voided'
 * @param {string} entry.documentType      invoice | payment | return |
 *                                         credit_note | customer_credit |
 *                                         credit_application | user
 * @param {number|null} [entry.documentId]
 * @param {string|null} [entry.invoiceReference]
 * @param {object|null} [entry.before]     state before the change
 * @param {object|null} [entry.after]      state after the change
 * @param {number|null} [entry.amountPaisa] monetary amount after the change
 * @param {string|null} [entry.reason]
 */
export async function writeAudit(tx, entry) {
    const client = tx ?? prisma;
    const actor = entry.actor ?? null;

    await client.auditLog.create({
        data: {
            userId: actor?.id ?? null,
            userSnapshotName: actor?.fullName ?? null,
            userSnapshotEmail: actor?.email ?? null,
            action: entry.action,
            documentType: entry.documentType,
            documentId: entry.documentId ?? null,
            invoiceReference: entry.invoiceReference ?? null,
            beforeJson: entry.before ? JSON.stringify(entry.before) : null,
            afterJson: entry.after ? JSON.stringify(entry.after) : null,
            amount:
                entry.amountPaisa === null || entry.amountPaisa === undefined
                    ? null
                    : toAmount(entry.amountPaisa),
            reason: entry.reason ?? null,
        },
    });
}

/** Parses a stored JSON snapshot back into an object (or null). */
export function parseSnapshot(json) {
    if (!json) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

/**
 * Serialises an AuditLog row for the API. Money is returned as paisa as well,
 * so clients never have to re-derive it from a float.
 */
export function serializeAudit(row) {
    return {
        id: row.id,
        userId: row.userId,
        userName: row.userSnapshotName ?? 'Unknown user',
        userEmail: row.userSnapshotEmail ?? null,
        action: row.action,
        documentType: row.documentType,
        documentId: row.documentId,
        invoiceReference: row.invoiceReference,
        before: parseSnapshot(row.beforeJson),
        after: parseSnapshot(row.afterJson),
        amount: row.amount === null ? null : Number(row.amount),
        amountPaisa: row.amount === null ? null : toPaisa(row.amount),
        reason: row.reason,
        createdAt: row.createdAt,
    };
}