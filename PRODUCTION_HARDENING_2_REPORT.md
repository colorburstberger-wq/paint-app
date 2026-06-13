# Production Hardening 2 Report

## Implemented

1. Split reusable logic out of `src/main.jsx` into:
   - `src/lib/appMeta.js`
   - `src/lib/security.js`
   - `src/lib/businessRules.js`
2. Pinned dependency versions instead of `latest`.
3. Added `npm run test` and `npm run check`.
4. Added Node test coverage for:
   - Supabase URL/key validation
   - signup redirect helper
   - HTML escaping
   - over-issue prevention
   - deposit/damage settlement
   - paid invoice lock rule
5. Added GitHub Actions CI workflow: `.github/workflows/ci.yml`.
6. Re-enabled production chunk splitting in Vite:
   - React vendor chunk
   - Supabase vendor chunk
   - app core chunk
   - main app chunk
7. Strengthened business guards:
   - direct rental issue blocks zero/over-available quantity
   - quotation-to-issue conversion blocks over-issue per article
   - paid/part-paid invoices are locked from direct edit
   - payroll runs are voided instead of deleted
   - payroll-created expense is linked and voided with payroll run
8. Added typed Supabase reporting views:
   - `v_rental_customers`
   - `v_rental_articles`
   - `v_rental_invoices`
9. Added `.gitignore` and `.env.example`.

## Verified

- `npm run test` passed.
- `npm run build` passed.
- `npm run check` passed.

## Still not magically solved

This is stronger, but still not a perfect ERP. A full ERP-grade rewrite would still require a complete normalized database migration, backend functions for all financial transactions, server-side audit locking, and a larger test suite.
