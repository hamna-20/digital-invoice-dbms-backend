/**
 * Central FBR/PRAL-style mock validation and submission service.
 *
 * This file is the ONE authority for deciding whether an invoice is ready for
 * the internal mock workflow. Issuing an invoice, "Mock validate" and "Mock
 * submit" all call `validateInvoiceForFbr` so they can never disagree.
 *
 * Nothing here talks to FBR or PRAL. No token, credential, sandbox URL or
 * external request is used. The generated reference is prefixed with MOCK- and
 * the payload is stored only inside this application.
 */

import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';
import {
    FBR_MOCK_DISCLAIMER,
    FBR_MOCK_STATUS,
    FBR_MOCK_VERSION,
    FBR_PROVINCES,
    FBR_REGISTRATION_TYPES,
    FBR_SALE_TYPES,
    fbrSaleTypeInternal,
    fbrSaleTypeValue,
    fbrStatusLabel,
} from '../utils/fbr.js';
import { parseSnapshot, writeAudit } from './audit.service.js';

/**
 * FBR validation/submission is only allowed once the invoice is fully paid.
 * Every other status (draft, issued, partially_paid, overdue, cancelled) is
 * rejected by `runMockAction`.
 */
const FBR_ELIGIBLE_STATUS = 'paid';

const SOURCE = Object.freeze({
    SELLER: 'Seller',
    CUSTOMER: 'Customer',
    INVOICE: 'Invoice',
    PRODUCT: 'Product',
});

const invoiceFbrSelect = {
    id: true,
    userId: true,
    invoiceNumber: true,
    customerId: true,
    invoiceDate: true,
    dueDate: true,
    status: true,
    subtotal: true,
    taxTotal: true,
    grandTotal: true,
    notes: true,
    fbrSnapshotJson: true,
    customer: {
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            companyName: true,
            taxNumber: true,
            strn: true,
            registration: true,
            province: true,
            address: true,
            city: true,
        },
    },
    items: {
        orderBy: { id: 'asc' },
        select: {
            id: true,
            productId: true,
            productName: true,
            productCode: true,
            quantity: true,
            unitPrice: true,
            retailPrice: true,
            taxRate: true,
            lineSubtotal: true,
            lineTax: true,
            lineTotal: true,
            hsCode: true,
            uom: true,
            saleType: true,
            sroScheduleNo: true,
            sroItemSerialNo: true,
            extraTax: true,
            furtherTax: true,
            advanceTax: true,
            fedPayable: true,
            salesTaxWithheldAtSource: true,
            discount: true,
        },
    },
    mockFbrSubmission: {
        select: {
            id: true,
            reference: true,
            status: true,
            validatedAt: true,
            submittedAt: true,
            createdAt: true,
            updatedAt: true,
        },
    },
};

const toNumber = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
};

const round2 = (value) => Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
const toDateOnly = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};
const isBlank = (value) =>
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function visibleWhere(actor) {
    return actor.role === 'manager' || actor.role === 'admin' ? {} : { userId: actor.id };
}

/**
 * Loads the invoice, buyer and seller data the mock payload needs. Works with
 * the root client or a transaction client, so issue can capture its snapshot
 * inside the same transaction as the status change and stock movement.
 */
export async function loadInvoiceForFbrContext(db, actor, invoiceId) {
    const invoice = await db.invoice.findFirst({
        where: { id: invoiceId, ...visibleWhere(actor) },
        select: invoiceFbrSelect,
    });
    if (!invoice) throw ApiError.notFound('Invoice not found');

    const user = await db.user.findUnique({
        where: { id: invoice.userId },
        select: {
            businessProvince: true,
        },
    });

    const seller = await db.businessProfile.findUnique({
        where: { userId: invoice.userId },
        select: {
            businessName: true,
            ntn: true,
            strn: true,
            province: true,
            address: true,
            email: true,
            phone: true,
        },
    });

    return {
        invoice,
        seller: {
            ...seller,
            businessProvince: user?.businessProvince ?? seller?.province ?? null,
        },
    };
}

/** Builds the PRAL-v1.12-style payload. It is stored locally and never sent. */
export function buildFbrPayload(invoice, seller = {}) {
    const customer = invoice.customer ?? {};
    const items = (invoice.items ?? []).map((item, index) => {
        const rate = round2(item.taxRate);
        return {
            itemIndex: index + 1,
            productCode: item.productCode ?? null,
            productDescription: item.productName ?? null,
            hsCode: item.hsCode ?? null,
            rate,
            uoM: item.uom ? String(item.uom).toUpperCase() : null,
            quantity: toNumber(item.quantity),
            valueSalesExcludingST: round2(item.lineSubtotal),
            fixedNotifiedValueOrRetailPrice: round2(item.retailPrice),
            salesTaxApplicable: round2(item.lineTax),
            salesTaxWithheldAtSource: round2(item.salesTaxWithheldAtSource),
            extraTax: round2(item.extraTax),
            furtherTax: round2(item.furtherTax),
            advanceTax: round2(item.advanceTax),
            fedPayable: round2(item.fedPayable),
            discount: round2(item.discount),
            saleType: fbrSaleTypeValue(item.saleType),
            sroScheduleNo: item.sroScheduleNo ?? null,
            sroItemSerialNo: item.sroItemSerialNo ?? null,
        };
    });

    const total = (field) => round2(items.reduce((sum, item) => sum + toNumber(item[field]), 0));

    const buyerIsRegistered =
        typeof customer.registration === 'string' && customer.registration.toLowerCase() === 'registered';

    return {
        invoiceType: 'Sale Invoice',
        invoiceNumber: invoice.invoiceNumber ?? null,
        invoiceDate: toDateOnly(invoice.invoiceDate),
        dueDate: toDateOnly(invoice.dueDate),
        invoiceRefNo: invoice.invoiceNumber ?? null,

        sellerNTNCNIC: seller.ntn ?? null,
        sellerBusinessName: seller.businessName ?? null,
        sellerProvince: seller.province ?? seller.businessProvince ?? null,
        sellerAddress: seller.address ?? null,
        sellerSTRN: seller.strn ?? null,
        sellerEmail: seller.email ?? null,
        sellerPhone: seller.phone ?? null,

        buyerNTNCNIC: buyerIsRegistered ? (customer.taxNumber ?? '') : '',
        buyerSTRN: customer.strn ?? null,
        buyerBusinessName: customer.companyName || customer.name || null,
        buyerName: customer.name ?? null,
        buyerProvince: customer.province ?? null,
        buyerAddress: customer.address ?? null,
        buyerRegistrationType: buyerIsRegistered ? 'Registered' : 'Unregistered',
        buyerEmail: customer.email ?? null,
        buyerPhone: customer.phone ?? null,

        totalBillAmount: round2(invoice.grandTotal),
        totalSalesTaxApplicable: round2(invoice.taxTotal),
        totalSalesTaxWithheldAtSource: total('salesTaxWithheldAtSource'),
        totalExtraTax: total('extraTax'),
        totalFurtherTax: total('furtherTax'),
        totalAdvanceTax: total('advanceTax'),
        totalFedPayable: total('fedPayable'),
        totalDiscount: total('discount'),
        totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
        items,

        mockVersion: FBR_MOCK_VERSION,
        mockOnly: true,
        disclaimer: FBR_MOCK_DISCLAIMER,
    };
}

/**
 * The authoritative validation. Every error names the exact field and its
 * source so the UI can point at Customer, Product, Invoice or Seller data.
 *
 * Required vs. conditional:
 *   - HS code, UoM and sale type are required on every product line.
 *   - Buyer NTN/CNIC is required only for a Registered buyer.
 *   - STRN and SRO fields are warnings ("if applicable"), because their legal
 *     requirement depends on the seller's registration and the sale
 *     classification. They are never guessed here.
 */
export function validateInvoiceForFbr({ invoice, seller = {} }) {
    const errors = [];
    const warnings = [];

    const error = (source, field, message) => errors.push({ source, field, message });
    const warning = (source, field, message) => warnings.push({ source, field, message });

    // ------------------------------- Seller -------------------------------
    if (isBlank(seller.businessName)) {
        error(SOURCE.SELLER, 'seller.businessName', 'Seller business name is required.');
    }
    if (isBlank(seller.ntn)) {
        error(SOURCE.SELLER, 'seller.ntn', 'Seller NTN/CNIC is required.');
    }
    if (isBlank(seller.province)) {
        error(SOURCE.SELLER, 'seller.province', 'Seller province is required.');
    } else if (!FBR_PROVINCES.includes(seller.province)) {
        error(SOURCE.SELLER, 'seller.province', `Seller province must be one of: ${FBR_PROVINCES.join(', ')}.`);
    }
    if (isBlank(seller.address)) {
        error(SOURCE.SELLER, 'seller.address', 'Seller address is required.');
    }
    if (isBlank(seller.strn)) {
        warning(
            SOURCE.SELLER,
            'seller.strn',
            'Seller STRN is missing. Add it if your business is registered for sales tax.'
        );
    }

    // ------------------------------ Customer ------------------------------
    const customer = invoice?.customer ?? {};
    if (isBlank(customer.name)) {
        error(SOURCE.CUSTOMER, 'customer.name', 'Buyer name is required.');
    }
    if (isBlank(customer.registration)) {
        error(SOURCE.CUSTOMER, 'customer.registration', 'Buyer registration type is required.');
    } else if (!FBR_REGISTRATION_TYPES.includes(customer.registration) && !['End User', 'Foreign', 'Exempted'].includes(customer.registration)) {
        error(
            SOURCE.CUSTOMER,
            'customer.registration',
            `Buyer registration type must be one of: ${FBR_REGISTRATION_TYPES.join(', ')}, End User, Foreign, Exempted.`
        );
    }
    if (isBlank(customer.province)) {
        error(SOURCE.CUSTOMER, 'customer.province', 'Buyer province is required.');
    } else if (!FBR_PROVINCES.includes(customer.province)) {
        error(SOURCE.CUSTOMER, 'customer.province', `Buyer province must be one of: ${FBR_PROVINCES.join(', ')}.`);
    }
    if (isBlank(customer.address)) {
        error(SOURCE.CUSTOMER, 'customer.address', 'Buyer address is required.');
    }
    if (['Registered', 'Foreign'].includes(customer.registration) && isBlank(customer.taxNumber)) {
        error(
            SOURCE.CUSTOMER,
            'customer.taxNumber',
            'Buyer NTN/CNIC or passport is required for this buyer type.'
        );
    }
    if (customer.registration === 'Registered' && isBlank(customer.strn)) {
        warning(
            SOURCE.CUSTOMER,
            'customer.strn',
            'Buyer STRN is missing. Add it if the buyer is registered for sales tax.'
        );
    }

    // ------------------------------- Invoice ------------------------------
    if (isBlank(invoice?.invoiceNumber)) {
        error(SOURCE.INVOICE, 'invoiceNumber', 'Invoice number is required.');
    }
    if (!invoice?.invoiceDate) {
        error(SOURCE.INVOICE, 'invoiceDate', 'Invoice date is required.');
    }
    if (!Array.isArray(invoice?.items) || invoice.items.length === 0) {
        error(SOURCE.INVOICE, 'items', 'At least one invoice item is required.');
    }

    // ------------------------------- Products -----------------------------
    (invoice?.items ?? []).forEach((item, index) => {
        const path = `items[${index}]`;
        const productLabel = item.productName ? `Product "${item.productName}"` : `Item ${index + 1}`;

        if (isBlank(item.productName)) {
            error(SOURCE.PRODUCT, `${path}.productName`, `Item ${index + 1}: product description is required.`);
        }

        const quantity = toNumber(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
            error(SOURCE.PRODUCT, `${path}.quantity`, `${productLabel}: quantity must be a whole number above zero.`);
        }

        if (isBlank(item.hsCode)) {
            error(SOURCE.PRODUCT, `${path}.hsCode`, `${productLabel}: HS code is required.`);
        }

        if (isBlank(item.uom)) {
            error(SOURCE.PRODUCT, `${path}.uom`, `${productLabel}: unit of measure (UoM) is required.`);
        }

        if (isBlank(item.saleType)) {
            error(SOURCE.PRODUCT, `${path}.saleType`, `${productLabel}: sale type is required.`);
        } else if (!FBR_SALE_TYPES.includes(item.saleType)) {
            error(
                SOURCE.PRODUCT,
                `${path}.saleType`,
                `${productLabel}: sale type must be one of: ${FBR_SALE_TYPES.join(', ')}.`
            );
        }

        if (item.saleType === 'Third Schedule') {
            const retailPrice = toNumber(item.retailPrice);
            if (isBlank(item.retailPrice) || retailPrice <= 0) {
                error(
                    SOURCE.PRODUCT,
                    `${path}.retailPrice`,
                    `${productLabel}: fixed/notified retail price is required for Third Schedule goods.`
                );
            }
        }

        const rate = toNumber(item.taxRate);
        if (rate < 0 || rate > 100) {
            error(SOURCE.PRODUCT, `${path}.rate`, `${productLabel}: sales tax rate must be between 0 and 100.`);
        }

        if (item.saleType === 'Taxable' && rate === 0) {
            warning(
                SOURCE.PRODUCT,
                `${path}.rate`,
                `${productLabel}: sale type is Taxable but the sales tax rate is 0%. Confirm this is intended.`
            );
        }
        if ((item.saleType === 'Exempt' || item.saleType === 'Zero-rated') && rate > 0) {
            warning(
                SOURCE.PRODUCT,
                `${path}.rate`,
                `${productLabel}: sale type is ${item.saleType} but the sales tax rate is above 0%. Confirm this is intended.`
            );
        }
        if (item.saleType && item.saleType !== 'Taxable' && isBlank(item.sroScheduleNo)) {
            warning(
                SOURCE.PRODUCT,
                `${path}.sroScheduleNo`,
                `${productLabel}: SRO schedule/item serial may be required for ${item.saleType} sales. Confirm with your tax adviser.`
            );
        }
    });

    return { errors, warnings };
}

export function serializeFbrSummary(submission) {
    const status = submission?.status ?? null;
    return {
        status,
        statusLabel: fbrStatusLabel(status),
        reference: submission?.reference ?? null,
        validatedAt: submission?.validatedAt ?? null,
        submittedAt: submission?.submittedAt ?? null,
        mockVersion: FBR_MOCK_VERSION,
        disclaimer: FBR_MOCK_DISCLAIMER,
    };
}

function serializeSubmission(submission) {
    if (!submission) return null;
    return {
        id: submission.id,
        reference: submission.reference,
        status: submission.status,
        statusLabel: fbrStatusLabel(submission.status),
        validatedAt: submission.validatedAt,
        submittedAt: submission.submittedAt,
        payload: parseSnapshot(submission.payloadJson),
        validation: parseSnapshot(submission.validationJson),
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
        mockVersion: FBR_MOCK_VERSION,
        disclaimer: FBR_MOCK_DISCLAIMER,
    };
}

/**
 * Rebuilds the validator's input from a stored issue snapshot. Used for every
 * action on an issued invoice so later product/customer edits can never
 * rewrite what was true when the invoice was issued.
 */
export function contextFromFbrSnapshot(snapshot) {
    return {
        invoice: {
            invoiceNumber: snapshot.invoiceNumber ?? null,
            invoiceDate: snapshot.invoiceDate ?? null,
            customer: {
                name: snapshot.buyerName ?? snapshot.buyerBusinessName ?? null,
                registration: snapshot.buyerRegistrationType ?? null,
                province: snapshot.buyerProvince ?? null,
                address: snapshot.buyerAddress ?? null,
                taxNumber: snapshot.buyerNTNCNIC ?? null,
                strn: snapshot.buyerSTRN ?? null,
            },
            items: (snapshot.items ?? []).map((item) => ({
                productName: item.productDescription ?? null,
                quantity: item.quantity,
                hsCode: item.hsCode ?? null,
                uom: item.uoM ?? null,
                saleType: fbrSaleTypeInternal(item.saleType),
                retailPrice: item.fixedNotifiedValueOrRetailPrice ?? null,
                sroScheduleNo: item.sroScheduleNo ?? null,
                taxRate: item.rate,
            })),
        },
        seller: {
            businessName: snapshot.sellerBusinessName ?? null,
            ntn: snapshot.sellerNTNCNIC ?? null,
            province: snapshot.sellerProvince ?? null,
            address: snapshot.sellerAddress ?? null,
            strn: snapshot.sellerSTRN ?? null,
        },
    };
}

/**
 * Chooses the frozen issue snapshot when one exists, otherwise the live rows
 * (drafts). Returns both the validation context and the payload so callers
 * never mix a live payload with snapshot validation.
 */
function resolveFbrSource(invoice, seller) {
    const snapshot = parseSnapshot(invoice.fbrSnapshotJson);
    if (snapshot && snapshot.mockOnly) {
        return {
            context: contextFromFbrSnapshot(snapshot),
            payload: snapshot,
            fromSnapshot: true,
        };
    }
    return {
        context: { invoice, seller },
        payload: buildFbrPayload(invoice, seller),
        fromSnapshot: false,
    };
}

/** Read-only readiness endpoint data. Never blocks or mutates. */
export async function getInvoiceFbrReadiness(actor, invoiceId) {
    const { invoice, seller } = await loadInvoiceForFbrContext(prisma, actor, invoiceId);
    const source = resolveFbrSource(invoice, seller);
    const validation = validateInvoiceForFbr(source.context);

    return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceStatus: invoice.status,
        eligible: invoice.status === FBR_ELIGIBLE_STATUS,
        mandatory: true,
        ready: validation.errors.length === 0,
        errors: validation.errors,
        warnings: validation.warnings,
        payload: source.payload,
        fromIssueSnapshot: source.fromSnapshot,
        snapshot: parseSnapshot(invoice.fbrSnapshotJson),
        submission: serializeSubmission(
            invoice.mockFbrSubmission
                ? {
                    ...invoice.mockFbrSubmission,
                    payloadJson: null,
                    validationJson: null,
                }
                : null
        ),
        statusLabel: fbrStatusLabel(invoice.mockFbrSubmission?.status ?? null),
        mockVersion: FBR_MOCK_VERSION,
        disclaimer: FBR_MOCK_DISCLAIMER,
    };
}

/**
 * Shared implementation for mock validation and mock submission.
 * A missing required field stops the action with a 400 that lists every exact
 * field and its source.
 */
async function runMockAction(actor, invoiceId, mode) {
    const action = mode === 'submitted' ? 'submitted' : 'validated';

    return prisma.$transaction(async (tx) => {
        const { invoice, seller } = await loadInvoiceForFbrContext(tx, actor, invoiceId);

        if (invoice.status !== FBR_ELIGIBLE_STATUS) {
            throw ApiError.conflict(
                `Invoice ${invoice.invoiceNumber} must be fully paid before it can be ${action}. Its current status is "${invoice.status}".`
            );
        }

        const source = resolveFbrSource(invoice, seller);
        const validation = validateInvoiceForFbr(source.context);
        if (validation.errors.length > 0) {
            throw ApiError.badRequest(
                'Invoice is not ready for FBR submission',
                validation.errors
            );
        }

        const payload = source.payload;
        const now = new Date();
        const reference = `FBR-${invoice.invoiceNumber}`;
        const existing = invoice.mockFbrSubmission
            ? await tx.mockFbrSubmission.findUnique({ where: { invoiceId } })
            : null;

        const keepSubmitted = existing?.status === FBR_MOCK_STATUS.SUBMITTED;
        const status =
            action === 'submitted' || keepSubmitted
                ? FBR_MOCK_STATUS.SUBMITTED
                : FBR_MOCK_STATUS.VALIDATED;

        const data = {
            reference,
            status,
            payloadJson: JSON.stringify(payload),
            validationJson: JSON.stringify({
                valid: true,
                errors: [],
                warnings: validation.warnings,
                mockVersion: FBR_MOCK_VERSION,
            }),
            validatedAt: existing?.validatedAt ?? now,
            submittedAt: action === 'submitted' ? now : existing?.submittedAt ?? null,
        };

        const submission = existing
            ? await tx.mockFbrSubmission.update({ where: { invoiceId }, data })
            : await tx.mockFbrSubmission.create({
                data: {
                    ...data,
                    invoiceId,
                    createdBy: actor.id,
                },
            });

        await tx.invoiceActivity.create({
            data: {
                invoiceId,
                actorId: actor.id,
                eventType: action === 'submitted' ? 'fbr_mock_submitted' : 'fbr_mock_validated',
                description:
                    action === 'submitted'
                        ? `FBR submission recorded (${reference}).`
                        : `FBR validation passed (${reference}).`,
            },
        });

        await writeAudit(tx, {
            actor,
            action: action === 'submitted' ? 'fbr.mock_submitted' : 'fbr.mock_validated',
            documentType: 'invoice',
            documentId: invoiceId,
            invoiceReference: invoice.invoiceNumber,
            after: {
                status,
                reference,
                mockVersion: FBR_MOCK_VERSION,
                warningCount: validation.warnings.length,
                totalBillAmount: toNumber(invoice.grandTotal),
            },
            reason: 'FBR submission workflow',
        });

        return {
            invoiceId,
            invoiceNumber: invoice.invoiceNumber,
            status,
            statusLabel: fbrStatusLabel(status),
            reference,
            submission: {
                ...serializeSubmission({
                    ...submission,
                    payloadJson: data.payloadJson,
                    validationJson: data.validationJson,
                }),
            },
            warnings: validation.warnings,
            payload,
            mockVersion: FBR_MOCK_VERSION,
            disclaimer: FBR_MOCK_DISCLAIMER,
        };
    });
}

export function mockValidateInvoice(actor, invoiceId) {
    return runMockAction(actor, invoiceId, 'validated');
}

export function mockSubmitInvoice(actor, invoiceId) {
    return runMockAction(actor, invoiceId, 'submitted');
}

/**
 * Rebuilds Invoice.fbrSnapshotJson after an issued invoice's own lines or
 * customer change. It deliberately does not block the edit: only issue and the
 * mock actions are gated. A later mock validation reports anything missing.
 */
export async function refreshInvoiceFbrSnapshot(tx, actor, invoiceId) {
    const { invoice, seller } = await loadInvoiceForFbrContext(tx, actor, invoiceId);
    const payload = buildFbrPayload(invoice, seller);
    await tx.invoice.update({
        where: { id: invoiceId },
        data: { fbrSnapshotJson: JSON.stringify(payload) },
    });
    return payload;
}
