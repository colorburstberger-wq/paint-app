# Rental Services OS - Supabase Login + Google Drive Media

A React/Vite business app for:

1. Construction Tool Rental
2. Interior Sample / Catalogue Rental

This build fixes the important architecture issue:

**Supabase = login, roles, and business data**  
**Google Drive = photos, bills, proofs, videos, catalogues, and backup media**

## What changed in this version

- Real Supabase Auth login screen added.
- Role is no longer only a UI switch.
- Signed-in user role comes from `public.app_users` in Supabase.
- Roles supported:
  - Owner
  - Operations Manager
  - Field Staff
- Owner gets full access.
- Operations Manager gets daily work, customer, quotation, invoice, payment, inventory and reports access.
- Field Staff gets simplified daily work access.
- Owner View recovery button was removed for non-owner users.
- Supabase is now the primary business data layer through authenticated snapshot saving/loading.
- Browser LocalStorage is only used as local cache.
- Media upload path is now Google Drive only.
- Supabase Storage is no longer used for photos/bills/proofs.
- App records store Google Drive file metadata and links.
- `supabase-setup.sql` now creates Auth-linked `app_users`, RLS policies, role profile table, and the business snapshot table.

## Main business features

### Customer / Party Master

- Client, contractor, staff, vendor and other party records
- Mobile, alternate mobile, GSTIN, city, address, opening balance and notes
- Party reuse in quotations, billing and ledgers

### Article Master

- Construction tools and interior sample/catalogue articles
- Category, subcategory, brand, model, serial number, purchase date, purchase cost
- Stock quantity, current location, condition and status
- Rent rate, rent unit, default deposit and replacement cost
- Accessories list, notes, article photo and purchase bill upload
- Media files upload to Google Drive when connected

### Estimate / Quotation Builder

- Create estimate/quotation with quote number and status
- Customer/site details, quote date, valid till, expected issue date
- Rental/service/sale/transport line items
- Quantity, duration, unit, rate, discount, GST/tax, deposit
- Delivery charge, pickup charge and round-off
- Terms and notes
- Print / Save as PDF through browser print
- Quotation register: Draft, Sent, Approved, Rejected, Converted, Issued
- Convert approved quotation into rental issue records
- Create invoice directly from quotation

### Rental Issue Workflow

- Issue articles to client/contractor/staff/vendor/other
- Site/client link, purpose, issue date and expected return date
- Deposit, advance, delivery charge and payment mode
- ID proof upload, before photos/videos, condition checklist and accessory checklist
- Active rental dashboard with due/overdue tracking

### Return Workflow

- Returned quantity and missing quantity
- Return checklist, after photos/videos, condition after return
- Late penalty, damage deduction, repair required, cleaning required
- Deposit refund and final balance collection
- Automatically updates rental status and quantity returned

### Billing / Invoice

- Create invoice manually, from quotation, or from active rental
- Invoice number, invoice date, due date and status
- GST/tax, discount, delivery, pickup, round-off and terms
- Invoice register with total, paid and balance
- Record invoice payment and auto-update Paid / Part Paid status
- Print / Save as PDF through browser print

### Payments / Deposit Ledger

- Rent payment
- Invoice payment
- Advance rent
- Deposit collected
- Deposit refund
- Damage deduction
- Late penalty
- Repair recovery
- Link payment to rental, invoice and/or article

### Accounting

- Expense entry: transport, purchase, repair, staff salary, fuel, office, rent, marketing, other
- Linked article and linked rental expense tracking
- Revenue summary
- Expense summary
- Net profit estimate
- Receivable summary
- Deposit held as liability
- Customer-wise receivable ledger
- Daybook / cashbook
- Profit & loss summary

### Repair & Maintenance

- Repair/service/cleaning/accessory replacement records
- Repair cost, mechanic/vendor, recovered amount and recovered from
- Repair bill upload to Google Drive
- Status update after repair

### Reports

- Active rentals
- Overdue articles
- Damage returns
- Repair cost
- Customer-wise rental
- Contractor-wise rental
- Article-wise profit
- Lost articles
- Deposit pending
- Purchase bill / warranty

## Setup

### 1. Supabase setup

1. Create a Supabase project.
2. Enable Email Auth in Supabase Authentication settings.
3. Open Supabase Dashboard → SQL Editor.
4. Paste and run `supabase-setup.sql` from this ZIP.
5. Copy Project URL and anon public key from Project Settings → API.
6. Open the app.
7. Paste Project URL and anon public key on the login screen.
8. Create the first user.
9. Tick **Claim Owner role if this is the first owner account** for the first owner.
10. Log in.

Owner can manage staff by editing `public.app_users` in Supabase:

```sql
update public.app_users set role = 'Operations Manager' where email = 'manager@example.com';
update public.app_users set role = 'Field Staff' where email = 'staff@example.com';
update public.app_users set status = 'Inactive' where email = 'oldstaff@example.com';
```

### 2. Google Drive setup for media

1. In Google Cloud Console, enable Google Drive API.
2. Create OAuth 2.0 Client ID with application type: Web application.
3. Add your app origin, for example `http://localhost:5173`, under Authorized JavaScript origins.
4. In the app, open Settings as Owner.
5. Enable Google Drive for media files.
6. Paste the OAuth Web Client ID.
7. Click Connect Google Drive.
8. New photos, bills, ID proof, before/after photos, repair bills and catalogue files upload to the configured Drive folder.

This frontend version uses the Google Drive `drive.file` scope and no client secret.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Storage policy

- Supabase stores business records as an authenticated JSON snapshot in `rental_app_snapshots`.
- Google Drive stores media files.
- Supabase records keep Drive metadata such as file ID, file name, folder ID and view link.
- Local browser storage is only cache/fallback.

## Current technical boundary

This is still a frontend-first build. It now has real Supabase Auth + RLS snapshot storage, but a future production backend should normalize the snapshot into separate PostgreSQL tables for articles, customers, rentals, returns, invoices, payments, expenses, repairs and audit logs.

## Customer 360 / Past Records Upgrade

This version adds a dedicated **Customer 360 / Past Records** module.

What it shows for each customer/contractor/client:

- Customer profile and contact snapshot
- Full rental history linked by customer ID, phone number, or name
- Active, returned, overdue, damaged, and missing/lost status
- Google Drive media gallery grouped by:
  - ID proof
  - Before issue proof photos/videos
  - After return proof photos/videos
  - Repair bills
- Billing and payment ledger
- Quotations and invoices linked to the customer
- Trust/risk score based on overdue rentals, damages, missing articles, and receivable balance
- WhatsApp shortcut from the customer record

Supabase remains the main database/auth layer. Google Drive remains the preferred media storage layer; Supabase stores business records and Drive file metadata/links.

## Article 360 / Article Trace Upgrade

This version adds a dedicated **Article 360 / Article Trace** module.

What it shows for each rental article:

- Article identity: code, name, type, category, brand, serial/model, quantity, condition and status
- Current custody: who currently has the article, site, due date, outstanding quantity and overdue status
- Complete rental timeline: every issue and return linked to that article
- Google Drive media gallery grouped by:
  - Article photo
  - Purchase bill
  - ID proof
  - Before issue proof photos/videos
  - After return proof photos/videos
  - Repair bills
- Repair and damage history
- Purchase order, expense, quotation and invoice links
- Article-wise profitability ledger
- Net profit calculation using purchase cost, rent earned, damage/late recovery, repairs and expenses
- Article health/risk score for repair, retirement or replacement decisions

Open it from **Inventory → Article 360 / Trace** or click **Trace** in the Article Master row.

## Task Scheduler Upgrade

This build includes a stronger task/follow-up scheduler:

- One-time, Daily, Weekly, and Bi-Monthly task schedules.
- Bi-Monthly means every 15 days.
- Follow-up date automatically controls when a task appears in Daily Tasks.
- If a follow-up date reaches today, the task is carried forward into the Daily Task List.
- If a daily task is not completed, it remains in Daily Tasks as overdue.
- Recurring tasks automatically move to their next date after being marked Done.
- Quick date buttons: Today, Tomorrow, +7 Days, +15 Days.
- Tasks can be linked to Rental, Invoice, Customer, or Article records.
- Only the Owner role can remove/delete a task from the task board.
- Staff can complete, reopen, reschedule, and WhatsApp follow up, but cannot remove tasks.

## Task proof of work upgrade

The task scheduler now enforces proof before completion:

- Staff must add either a text reply or proof media before marking a task as Done.
- Proof media can be photo, video, or PDF.
- When Google Drive is connected, proof media uploads to Google Drive and the app stores the Drive link/metadata in Supabase business data.
- If Drive upload fails and local fallback is enabled, proof is temporarily stored locally.
- Recurring daily/weekly/bi-monthly tasks keep proof history for each completion, then reset proof fields for the next scheduled date.
- Owner can remove tasks and can remove proof media before task completion.
- Task proof media appears in the attachment register, Customer 360, and Article 360 when linked.


## GPS Attendance Module

This version includes Staff Attendance:

- Staff check-in with browser GPS
- Staff check-out with browser GPS
- GPS latitude, longitude and accuracy saved with timestamps
- Field Staff can see their own attendance
- Operations Manager and Owner can view staff attendance
- Only Owner can void/remove attendance records
- Attendance records are stored in the Supabase business-data snapshot
- Google Drive remains for media files such as photos, bills and proof attachments

Browser location permission is required for check-in/check-out. Manual coordinate entry is intentionally disabled for normal staff.

## Bug-fixed build notes

This build fixes and consolidates the latest working app package:

- Restored the real React/Vite app package after the temporary salary placeholder ZIP.
- Added Salary / Payroll as an actual module inside the app.
- Fixed Supabase snapshot payload so GPS attendance is saved to Supabase, not only local browser storage.
- Added staff salary slabs, approved leave, unapproved leave / absentee, weekly-off bonus, payroll runs, and payslip print.
- Added Owner-only salary rules and Owner-only payroll generation/deletion.
- Enforced Owner-only recurring task creation. Staff can still add one-time follow-ups and submit proof of work.
- Kept Google Drive as the media store and Supabase as the business data/auth store.

Build validation: `npm install` and `npm run build` pass.

## Production hardening implemented in this build

This build implements the previous bug-hunt checklist except item 6 automated regression tests.

### 1. Security and access control
- Supabase Auth remains mandatory before the app shell opens.
- Role profile is loaded from `app_users`.
- Menu access is role filtered and disallowed tabs are automatically redirected to Home.
- `supabase-setup.sql` now creates relational tables with RLS instead of relying only on one shared JSON snapshot.
- Legacy `rental_app_snapshots` remains as fallback/migration only and is limited to Owner/Operations Manager.

### 2. Data consistency and sync
- Supabase now prefers separate tables for articles, customers, rentals, returns, payments, tasks, attendance, payroll, repairs, invoices, quotations and audit logs.
- Google Drive remains the only media store for uploaded photos/bills/proofs/catalogues.
- Supabase stores Google Drive file metadata in `media_files` using `drive_file_id` as a unique key to reduce duplicate media metadata on retry.
- Snapshot fallback remains if the relational schema has not yet been run.

### 3. Business logic corrections
- Return/deposit logic now separates:
  - rent + late charges,
  - damage deducted from deposit,
  - extra damage payable beyond deposit,
  - deposit refund.
- This avoids double-counting damage as both collected cash and deposit deduction.
- Payroll now auto-detects absent days where there is no attendance and no approved leave, excluding weekly-off days.
- Weekly-off bonus is granted only when all weekly-off days in the payroll month were worked.
- GPS attendance now stores GPS accuracy warnings for weak location capture.

### 4. UI/UX fixes
- Added mobile table-to-card fallback for very small screens.
- Added visible focus outlines and sidebar button aria labels.
- Added dark-mode contrast corrections.
- Added clearer deposit adjustment preview in the return flow.

### 5. Performance/resource hardening
- The app uses Google Identity + Drive REST upload directly; it does not bundle a heavy server-side `googleapis` client.
- Media files stay in Google Drive and are represented in Supabase as metadata/links.
- The task scheduler already uses memoized task lists to reduce repeated filtering.

### 7. Static/helper hardening without automated tests
- Date/payroll/storage calculations have been consolidated inside shared helpers in the app source.
- Supabase SQL policies are centralized in `supabase-setup.sql`.
- Global user-facing errors are surfaced through toast/notice messages instead of silent failures in the main flows.

Automated Playwright/Cypress/Vitest tests were intentionally not added because they were excluded by request.

## Vercel + Supabase auth redirect note

The app now passes the current deployed origin as `emailRedirectTo` during Supabase sign-up. This prevents confirmation emails from redirecting to `localhost` when the app is deployed on Vercel, as long as the same Vercel URL is also allowed in Supabase Auth URL Configuration.

Use a Supabase Project URL like `https://xxxxx.supabase.co` and a public browser key starting with either `sb_publishable_` or the legacy `eyJ...` anon key format. Never use the `service_role` or secret key in this app.

## 2026-06-13 Production Fix Notes

This package includes the production-fix pass requested after deployment testing:

- Supabase signup now uses the live app origin for email confirmation redirects (`emailRedirectTo: window.location.origin`).
- Supabase connection validation accepts both `sb_publishable_...` keys and legacy JWT anon keys.
- Supabase client creation now blocks invalid project URLs, service-role-like mistakes, and empty keys earlier with clearer messages.
- Local browser caching now stores settings only by default. Business records should live in Supabase. A separate emergency toggle can cache business records locally if needed.
- Supabase JSON snapshot fallback and Drive local-file fallback are OFF by default for safer production behaviour.
- Print/PDF HTML output now escapes user-entered document fields before writing to the print window.
- Vite config has been updated to remove the deprecated `inlineDynamicImports` build option.

Recommended Supabase URL settings:

- Site URL: your Vercel app URL
- Redirect URL: `https://your-vercel-app.vercel.app/**`

Run `supabase-setup.sql` before creating users.

## Production Hardening 2

This package includes safer deployment defaults and additional production guards:

- pinned dependency versions
- CI workflow
- automated Node tests
- split Vite production chunks
- Supabase/Vercel auth redirect helper
- paid invoice edit lock
- rental over-issue guard
- payroll void instead of delete
- typed Supabase reporting views

Run locally or in Codespaces:

```bash
npm ci
npm run check
```
