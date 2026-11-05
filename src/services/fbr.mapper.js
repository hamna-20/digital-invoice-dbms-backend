/**
 * New FBR payload mapper.
 *
 * This is the standalone builder used by the new fbr-preview endpoint and the
 * issue-time FBR readiness check. It uses the stored invoice line values
 * (lineSubtotal, lineTax, lineTotal) so the mapping never recalculates money.
 *
 * Sandbox scenario IDs and field names must be confirmed against the FBR DI API spec v1.12 before live use.
 */

import { fbrSaleTypeValue } from '../utils/fbr.js';

/**
 * @param {object} invoice
 * @param {object} seller
 * @param {object} buyer
 * @param {Array<object>} products
 * @returns {object}
 */
export function buildFbrPayload(invoice, seller = {}, buyer = {}, products = []) {
    const toNumber = (value) =>
        value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value);

    const customer = invoice?.customer ?? {};
    const buyerIsRegistered =
        typeof customer.registration === 'string' && customer.registration.toLowerCase() === 'registered';

    const items = (invoice?.items ?? []).map((item) => {
        const product = products.find((p) => p && p.id === item.productId);
        return {
            hsCode: item?.hsCode ?? product?.hsCode ?? '',
            productDescription: item?.productName ?? product?.name ?? '',
            rate: toNumber(item?.taxRate ?? product?.taxRate ?? 0).toFixed(0) + '%',
            uoM: item?.uom
                ? String(item.uom).toUpperCase()
                : item?.unit
                    ? String(item.unit).toUpperCase()
                    : product?.unit
                        ? String(product.unit).toUpperCase()
                        : '',
            quantity: toNumber(item?.quantity ?? 0).toFixed(4),
            valueSalesExcludingST: toNumber(item?.lineSubtotal ?? 0),
            fixedNotifiedValueOrRetailPrice: toNumber(
                item?.retailPrice ?? product?.retailPrice ?? 0
            ),
            salesTaxApplicable: toNumber(item?.lineTax ?? 0),
            totalValues: toNumber(item?.lineTotal ?? 0),
            salesTaxWithheldAtSource: toNumber(item?.salesTaxWithheldAtSource ?? 0),
            extraTax: toNumber(item?.extraTax ?? product?.extraTax ?? 0),
            furtherTax: toNumber(item?.furtherTax ?? product?.furtherTax ?? 0),
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
        buyerNTNCNIC: buyerIsRegistered ? (customer.taxNumber ?? '') : '',
        buyerBusinessName: customer.companyName || customer.name || '',
        buyerProvince: customer.province ?? '',
        buyerAddress: customer.address ?? '',
        buyerRegistrationType: buyerIsRegistered ? 'Registered' : 'Unregistered',
        invoiceRefNo: '',
        scenarioId: buyerIsRegistered ? 'SN001' : 'SN002',
        items,
    };
}
