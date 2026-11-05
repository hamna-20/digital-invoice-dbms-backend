/**
 * Pure FBR-required-data rules.
 *
 * These functions never touch the database, never read the network, and never
 * depend on a transaction or on the current invoice snapshot. They only
 * validate the data shape and values that FBR needs to exist before an invoice
 * can be issued.
 *
 * The field prefixes used by validateInvoiceForFbr are chosen to match the
 * existing invoice read model: "seller." for the user/business profile, "buyer."
 * for the customer, and "items[i]." for each invoice line product.
 */

import { fbrSaleTypeValue } from '../utils/fbr.js';

export const FBR_PROVINCES = Object.freeze([
    'Punjab',
    'Sindh',
    'Khyber Pakhtunkhwa',
    'Balochistan',
    'Islamabad Capital Territory',
    'Gilgit-Baltistan',
    'Azad Jammu and Kashmir',
]);

export const FBR_SALE_TYPE_DEFAULT = 'Goods at standard rate (default)';

// Accepts a plain NTN/CNIC (7 or 13 digits), a formatted NTN (1234567-1) and
// a formatted CNIC (35202-1234567-1). The customer form stores identifiers in
// their formatted shape so invoices, snapshots and the FBR payload stay readable.
const NTN_PATTERN = /^\d{7}$|^\d{13}$|^\d{7}-\d$|^\d{5}-\d{7}-\d$/;
const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;

const isBlank = (value) =>
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const isRegistered = (value) =>
    typeof value === 'string' && value.trim().toLowerCase() === 'registered';

/**
 * @param {{ businessName?: string, businessNtn?: string, businessAddress?: string, businessProvince?: string }} user
 * @returns {{ field: string, message: string }[]}
 */
export function validateSeller(user = {}) {
    const errors = [];

    if (!user.businessName || isBlank(user.businessName)) {
        errors.push({ field: 'seller.businessName', message: 'Seller business name is required.' });
    }

    if (!user.businessNtn && !user.businessNtn !== false) {
        // Accept both businessNtn and businessNtn/CNIC-ish names used across the codebase.
    }
    const ntn = user.businessNtn;
    if (isBlank(ntn)) {
        errors.push({ field: 'seller.businessNtn', message: 'Seller NTN/CNIC is required.' });
    } else if (!NTN_PATTERN.test(String(ntn).trim())) {
        errors.push({ field: 'seller.businessNtn', message: 'Seller NTN/CNIC must be 7 or 13 digits.' });
    }

    if (!user.businessAddress || isBlank(user.businessAddress)) {
        errors.push({ field: 'seller.businessAddress', message: 'Seller address is required.' });
    }

    if (!user.businessProvince || isBlank(user.businessProvince)) {
        errors.push({ field: 'seller.businessProvince', message: 'Seller province is required.' });
    } else if (!FBR_PROVINCES.includes(user.businessProvince)) {
        errors.push({ field: 'seller.businessProvince', message: `Seller province must be one of: ${FBR_PROVINCES.join(', ')}.` });
    }

    return errors;
}

const VALID_REGISTRATIONS = new Set(['Registered', 'Unregistered', 'End User', 'Foreign', 'Exempted']);

/**
 * @param {{ name?: string, address?: string, province?: string, registration?: string, taxNumber?: string }} customer
 * @returns {{ field: string, message: string }[]}
 */
export function validateBuyer(customer = {}) {
    const errors = [];

    if (!customer.name || isBlank(customer.name)) {
        errors.push({ field: 'buyer.name', message: 'Buyer name is required.' });
    }

    if (!customer.address || isBlank(customer.address)) {
        errors.push({ field: 'buyer.address', message: 'Buyer address is required.' });
    }

    if (!customer.province || isBlank(customer.province)) {
        errors.push({ field: 'buyer.province', message: 'Buyer province is required.' });
    } else if (!FBR_PROVINCES.includes(customer.province)) {
        errors.push({ field: 'buyer.province', message: `Buyer province must be one of: ${FBR_PROVINCES.join(', ')}.` });
    }

    const registration = customer.registration;
    if (!registration || isBlank(registration)) {
        errors.push({ field: 'buyer.registration', message: 'Buyer registration type is required.' });
    } else if (!VALID_REGISTRATIONS.has(registration)) {
        errors.push({ field: 'buyer.registration', message: `Buyer registration type must be one of: ${[...VALID_REGISTRATIONS].join(', ')}.` });
    }

    if (isRegistered(registration) || registration === 'Foreign') {
        const taxNumber = customer.taxNumber;
        if (isBlank(taxNumber)) {
            errors.push({
                field: 'buyer.taxNumber',
                message:
                    registration === 'Foreign'
                        ? 'Buyer passport or foreign registration number is required.'
                        : 'Buyer NTN/CNIC is required for a Registered buyer.',
            });
        } else if (registration !== 'Foreign' && !NTN_PATTERN.test(String(taxNumber).trim())) {
            errors.push({ field: 'buyer.taxNumber', message: 'Buyer NTN/CNIC must be 7 or 13 digits.' });
        }
    } else {
        const taxNumber = customer.taxNumber;
        if (!isBlank(taxNumber) && !NTN_PATTERN.test(String(taxNumber).trim())) {
            errors.push({ field: 'buyer.taxNumber', message: 'Buyer NTN/CNIC must be 7 or 13 digits.' });
        }
    }

    return errors;
}

/**
 * @param {{ name?: string, hsCode?: string, unit?: string, saleType?: string, taxRate?: number | string, price?: number | string }} product
 * @returns {{ field: string, message: string }[]}
 */
export async function validateProduct(product = {}, fbrClient = null) {
    const errors = [];

    if (!product.name || isBlank(product.name)) {
        errors.push({ field: 'product.name', message: 'Product name is required.' });
    }

    if (!product.hsCode || isBlank(product.hsCode)) {
        errors.push({ field: 'product.hsCode', message: 'Product HS code is required.' });
    } else if (!HS_CODE_PATTERN.test(String(product.hsCode).trim())) {
        errors.push({ field: 'product.hsCode', message: 'Product HS code must be in the format 4 digits, a dot, then 4 digits (for example 1234.5678).' });
    } else if (fbrClient) {
        // Check if the HS code exists in FbrHsCode when reference data is available
        try {
            const isValid = await fbrClient.isValidHsCode(product.hsCode);
            if (!isValid) {
                errors.push({ field: 'product.hsCode', message: 'Select an HS code from the FBR list' });
            }
        } catch (error) {
            // If FBR reference data is not configured, don't block the save
            if (error.message !== 'FBR reference data not configured') {
                throw error;
            }
        }
    }

    if (!product.unit || isBlank(product.unit)) {
        errors.push({ field: 'product.unit', message: 'Product unit of measure is required.' });
    }

    if (!product.saleType || isBlank(product.saleType)) {
        errors.push({ field: 'product.saleType', message: 'Product sale type is required.' });
    } else if (product.saleType === 'Third Schedule') {
        const retailPrice = Number(product.retailPrice);
        if (product.retailPrice === null || product.retailPrice === undefined || product.retailPrice === '' || !Number.isFinite(retailPrice) || retailPrice <= 0) {
            errors.push({
                field: 'product.retailPrice',
                message: 'Fixed/notified retail price is required for Third Schedule goods.',
            });
        }
    }

    const taxRate = product.taxRate;
    if (taxRate === null || taxRate === undefined || taxRate === '') {
        errors.push({ field: 'product.taxRate', message: 'Product tax rate must be a number from 0 to 100.' });
    } else {
        const rate = Number(taxRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
            errors.push({ field: 'product.taxRate', message: 'Product tax rate must be a number from 0 to 100.' });
        }
    }

    const price = product.price;
    if (price === null || price === undefined || price === '') {
        errors.push({ field: 'product.price', message: 'Product price must be greater than 0.' });
    } else {
        const numericPrice = Number(price);
        if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
            errors.push({ field: 'product.price', message: 'Product price must be greater than 0.' });
        }
    }

    return errors;
}

/**
 * @param {{ user?: object, invoice?: { customer?: object, items?: Array<{ product?: object }> } }} context
 * @returns {{ field: string, message: string }[]}
 */
export function validateInvoiceForFbr({ user = {}, invoice = {}, fbrClient = null } = {}) {
    const errors = [];

    const sellerErrors = validateSeller(user);
    for (const e of sellerErrors) {
        errors.push({ field: e.field, message: e.message });
    }

    const buyer = invoice?.customer ?? {};
    const buyerErrors = validateBuyer(buyer);
    for (const e of buyerErrors) {
        errors.push({ field: 'buyer.' + e.field.split('.')[1], message: e.message });
    }

    // End consumer: CNIC mandatory on sales of Rs. 100,000 or more.
    const grandTotalNumber = Number(invoice?.grandTotal ?? 0);
    if (
        String(buyer?.registration ?? '').trim() === 'End User' &&
        isBlank(buyer?.taxNumber) &&
        Number.isFinite(grandTotalNumber) &&
        grandTotalNumber >= 100000
    ) {
        errors.push({
            field: 'buyer.taxNumber',
            message: 'Buyer CNIC is required for end-consumer sales of Rs. 100,000 or more.',
        });
    }

    const items = invoice?.items;
    if (!Array.isArray(items) || items.length === 0) {
        errors.push({ field: 'items', message: 'At least one invoice item is required.' });
    } else {
        items.forEach((item, index) => {
            const product = item?.product ?? {};
            const itemPrefix = `items[${index}].`;
            const productErrors = validateProduct(product, fbrClient);
            for (const e of productErrors) {
                const fieldName = e.field.split('.')[1];
                errors.push({ field: itemPrefix + fieldName, message: e.message });
            }
        });
    }

    return errors;
}

/**
 * Build the FBR "Sale Invoice" payload from the stored invoice values.
 *
 * Sandbox scenario IDs and field names must be confirmed against the FBR DI API spec v1.12 before live use.
 *
 * @param {object} invoice
 * @param {object} seller
 * @param {object} buyer
 * @param {Array<object>} products
 * @returns {object}
 */
export function buildFbrPayload(invoice, seller = {}, buyer = {}, products = []) {
    const toNumber = (value) => (value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value));

    const buyerRegistration = buyer?.registration;
    const buyerIsRegistered = typeof buyerRegistration === 'string' && buyerRegistration.toLowerCase() === 'registered';
    const buyerNTNCNIC = buyer?.taxNumber ? String(buyer.taxNumber) : '';
    const buyerBusinessName = buyer?.companyName || buyer?.name || '';
    const buyerProvince = buyer?.province || '';
    const buyerAddress = buyer?.address || '';

    const items = (invoice?.items ?? []).map((item, index) => {
        const product = products[index] ?? {};
        const rateNumber = Number(item?.taxRate ?? 0);
        const quantityNumber = Number(item?.quantity ?? 0);

        return {
            hsCode: item?.hsCode ?? product?.hsCode ?? '',
            productDescription: item?.productName ?? product?.name ?? '',
            rate: rateNumber.toFixed(0) + '%',
            uoM: item?.unit ? String(item.unit).toUpperCase() : product?.unit ? String(product.unit).toUpperCase() : '',
            quantity: quantityNumber.toFixed(4),
            valueSalesExcludingST: toNumber(item?.lineSubtotal ?? 0),
            fixedNotifiedValueOrRetailPrice: toNumber(item?.retailPrice ?? product?.retailPrice ?? 0),
            salesTaxApplicable: toNumber(item?.lineTax ?? 0),
            totalValues: toNumber(item?.lineTotal ?? 0),
            salesTaxWithheldAtSource: toNumber(item?.salesTaxWithheldAtSource ?? 0),
            extraTax: toNumber(item?.extraTax ?? 0),
            furtherTax: toNumber(item?.furtherTax ?? 0),
            sroScheduleNo: item?.sroScheduleNo ?? product?.sroScheduleNo ?? '',
            fedPayable: 0,
            discount: toNumber(item?.discount ?? 0),
            saleType: fbrSaleTypeValue(item?.saleType ?? product?.saleType ?? ''),
            sroItemSerialNo: item?.sroItemSerialNo ?? product?.sroItemSerialNo ?? '',
        };
    });

    return {
        invoiceType: 'Sale Invoice',
        invoiceDate: invoice?.invoiceDate ? String(invoice.invoiceDate).slice(0, 10) : '',
        sellerNTNCNIC: seller?.businessNtn ?? seller?.ntn ?? '',
        sellerBusinessName: seller?.businessName ?? '',
        sellerProvince: seller?.businessProvince ?? seller?.province ?? '',
        sellerAddress: seller?.businessAddress ?? seller?.address ?? '',
        buyerNTNCNIC,
        buyerBusinessName,
        buyerProvince,
        buyerAddress,
        buyerRegistrationType: buyerIsRegistered ? 'Registered' : 'Unregistered',
        invoiceRefNo: '',
        scenarioId: buyerIsRegistered ? 'SN001' : 'SN002',
        items,
    };
}
