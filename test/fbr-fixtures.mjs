/**
 * Shared fixture defaults for the FBR-gated e2e suites.
 *
 * Issuing an invoice now requires a complete seller profile, buyer
 * registration/province/address and product HS code/UoM/sale type. The tests
 * only exercise invoice business rules, so they use one clearly fake, internal
 * profile and unclassified sample values. Nothing here is a legal tax
 * classification or a real FBR submission.
 */

export const TEST_SELLER_PROFILE = Object.freeze({
    businessName: 'E2E Test Seller',
    ntn: '1234567-8',
    province: 'Punjab',
    address: 'E2E Test Address, Lahore',
});

/** Creates/updates the seller profile for the signed-in test user. */
export async function ensureSellerProfile(request, token) {
    return request('PUT', '/api/seller', { token, body: TEST_SELLER_PROFILE });
}

/** Buyer defaults required by the mock FBR readiness rules. */
export function customerFixture(body) {
    return {
        registration: 'Unregistered',
        province: 'Punjab',
        address: 'E2E Buyer Address',
        ...body,
    };
}

/** Product defaults required by the mock FBR readiness rules. */
export function productFixture(body) {
    return {
        unit: 'PCS',
        hsCode: '0000.0000',
        saleType: 'Taxable',
        ...body,
    };
}
