import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import './styles.css';
import { APP_VERSION, STORAGE_KEY } from './lib/appMeta.js';
import { assertValidSupabaseSettings, escapeHtml, getAuthRedirectUrl, isValidSupabasePublicKey, isValidSupabaseUrl } from './lib/security.js';
import { canIssueQuantity, shouldLockPaidInvoice } from './lib/businessRules.js';

const CHECKLISTS = {
  toolBefore: [
    'Machine is working',
    'Wire is not cut',
    'Plug is proper',
    'Switch is working',
    'Sound is normal',
    'No burning smell',
    'Blade/bit/accessory is present',
    'Safety guard is present',
    'Body is not cracked',
    'Photo/video proof taken'
  ],
  sampleBefore: [
    'All pages/samples present',
    'No torn pages',
    'No missing mica/PVC/laminate pieces',
    'Brand cover intact',
    'Catalogue is clean',
    'Photo taken before handover',
    'Expected return date written'
  ],
  returnCheck: [
    'Returned quantity matched',
    'Returned on time or penalty added',
    'Working condition checked',
    'Accessories returned',
    'Cleaning required checked',
    'Repair required checked',
    'Damage charge decided',
    'Deposit refund/deduction recorded',
    'After-return photo taken',
    'Final rent collected or pending marked'
  ]
};

const articleTypes = ['Construction Tool', 'Interior Sample / Catalogue'];
const articleStatus = ['Available', 'Issued', 'Reserved', 'In Repair', 'Damaged', 'Lost', 'Retired'];
const customerTypes = ['Client', 'Contractor', 'Staff', 'Vendor', 'Other'];
const paymentModes = ['Cash', 'UPI', 'Bank', 'Cheque', 'Credit'];
const rentUnits = ['Day', 'Week', 'Month', 'Event'];
const conditionOptions = ['Excellent', 'Good', 'Average', 'Needs Cleaning', 'Repair Required', 'Damaged', 'Lost'];
const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const leaveTypes = ['Approved Leave', 'Unapproved Leave / Absentee'];

function uid(prefix = 'ID') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function money(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

function daysBetween(start, end) {
  if (!start || !end) return 1;
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  const diff = Math.ceil((b - a) / 86400000);
  return Math.max(1, diff || 1);
}

function addDaysISO(dateValue, days) {
  const d = new Date((dateValue || todayISO()) + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function overdueDays(dueDate) {
  if (!dueDate) return 0;
  const diff = daysBetween(dueDate, todayISO());
  return new Date(dueDate + 'T00:00:00') < new Date(todayISO() + 'T00:00:00') ? diff : 0;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function percentAmount(base, percent) {
  return Math.round((toNumber(base) * toNumber(percent)) / 100);
}

function computeDocTotals(items = [], extra = {}) {
  const itemRows = items.map((it) => {
    const qty = Math.max(1, toNumber(it.qty || 1));
    const duration = Math.max(1, toNumber(it.duration || 1));
    const rate = toNumber(it.rate);
    const discount = toNumber(it.discount);
    const taxable = Math.max(0, qty * duration * rate - discount);
    const tax = percentAmount(taxable, it.taxPercent);
    const deposit = toNumber(it.deposit);
    return { ...it, qty, duration, rate, discount, taxable, tax, deposit, lineTotal: taxable + tax };
  });
  const subtotal = itemRows.reduce((sum, it) => sum + it.taxable, 0);
  const taxTotal = itemRows.reduce((sum, it) => sum + it.tax, 0);
  const depositTotal = itemRows.reduce((sum, it) => sum + it.deposit, 0);
  const delivery = toNumber(extra.deliveryCharge);
  const pickup = toNumber(extra.pickupCharge);
  const roundOff = toNumber(extra.roundOff);
  const grandTotal = subtotal + taxTotal + delivery + pickup + roundOff;
  const payableWithDeposit = grandTotal + depositTotal;
  return { items: itemRows, subtotal, taxTotal, depositTotal, delivery, pickup, roundOff, grandTotal, payableWithDeposit };
}

function docStatusTone(status) {
  if (['Approved', 'Paid', 'Issued', 'Converted'].includes(status)) return 'green';
  if (['Sent', 'Part Paid', 'Partial'].includes(status)) return 'blue';
  if (['Rejected', 'Cancelled', 'Overdue'].includes(status)) return 'red';
  return 'gray';
}

function nextNumber(prefix, rows = [], field = 'number') {
  const nums = rows.map((row) => String(row[field] || '').match(/(\d+)$/)?.[1]).filter(Boolean).map(Number);
  const next = (nums.length ? Math.max(...nums) : 1000) + 1;
  return `${prefix}-${next}`;
}

function invoicePaidAmount(invoiceId, payments = []) {
  return payments.filter((pmt) => pmt.invoiceId === invoiceId && pmt.type !== 'Deposit Refund').reduce((sum, pmt) => sum + toNumber(pmt.amount), 0);
}

function invoiceBalance(invoice, payments = []) {
  const total = computeDocTotals(invoice.items || [], invoice).grandTotal;
  return Math.max(0, total - invoicePaidAmount(invoice.id, payments));
}

function monthStartISO(monthKey = todayISO().slice(0, 7)) {
  return `${monthKey}-01`;
}

function monthEndISO(monthKey = todayISO().slice(0, 7)) {
  const [year, month] = String(monthKey).split('-').map(Number);
  if (!year || !month) return todayISO();
  return new Date(year, month, 0).toISOString().slice(0, 10);
}

function daysInPayrollMonth(monthKey = todayISO().slice(0, 7)) {
  const [year, month] = String(monthKey).split('-').map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

function dateRangeISO(start, end) {
  if (!start || !end) return [];
  const out = [];
  const d = new Date(start + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  let guard = 0;
  while (d <= last && guard < 370) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return out;
}

function weekDayName(dateValue) {
  const d = new Date((dateValue || todayISO()) + 'T00:00:00');
  return weekDays[d.getDay()] || 'Sunday';
}

function defaultSalaryRules() {
  return {
    approvedLeaveDeductionPercent: 50,
    unapprovedLeaveDeductionPercent: 100,
    absenteePenaltyPerDay: 0,
    weeklyOffBonusType: 'Per Worked Weekly Off',
    weeklyOffBonusAmount: 500,
    overtimeHourlyRate: 0,
    defaultWeeklyOffDay: 'Sunday'
  };
}

function normalizeSalaryRules(rules = {}) {
  return { ...defaultSalaryRules(), ...rules };
}

function getStaffList(store = {}, currentUser = null) {
  const fromProfiles = (store.staffProfiles || []).map((s) => ({
    id: s.id || s.userId || s.email || uid('STF'),
    userId: s.userId || s.id || '',
    staffName: s.staffName || s.fullName || s.name || s.email || 'Staff',
    role: s.role || 'Field Staff',
    mobile: s.mobile || '',
    baseSalary: toNumber(s.baseSalary),
    monthlyAllowance: toNumber(s.monthlyAllowance),
    monthlyDeduction: toNumber(s.monthlyDeduction),
    weeklyOffDay: s.weeklyOffDay || store.salaryRules?.defaultWeeklyOffDay || 'Sunday',
    status: s.status || 'Active'
  }));
  const byKey = new Map();
  for (const staff of fromProfiles) byKey.set(staff.id, staff);
  for (const row of store.attendance || []) {
    const key = row.userId || row.staffName;
    if (key && !byKey.has(key)) {
      byKey.set(key, {
        id: key,
        userId: row.userId || key,
        staffName: row.staffName || key,
        role: row.role || 'Field Staff',
        mobile: '',
        baseSalary: 0,
        monthlyAllowance: 0,
        monthlyDeduction: 0,
        weeklyOffDay: store.salaryRules?.defaultWeeklyOffDay || 'Sunday',
        status: 'Active'
      });
    }
  }
  if (currentUser) {
    const key = currentUser.id || currentUser.email;
    if (key && !byKey.has(key)) {
      byKey.set(key, {
        id: key,
        userId: key,
        staffName: currentUser.full_name || currentUser.email || 'Current User',
        role: currentUser.role || 'Field Staff',
        mobile: '',
        baseSalary: 0,
        monthlyAllowance: 0,
        monthlyDeduction: 0,
        weeklyOffDay: store.salaryRules?.defaultWeeklyOffDay || 'Sunday',
        status: 'Active'
      });
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.staffName).localeCompare(String(b.staffName)));
}

function leaveDaysForMonth(leave, monthKey) {
  const monthStart = monthStartISO(monthKey);
  const monthEnd = monthEndISO(monthKey);
  const start = String(leave.fromDate || leave.date || monthStart) < monthStart ? monthStart : (leave.fromDate || leave.date || monthStart);
  const end = String(leave.toDate || leave.date || start) > monthEnd ? monthEnd : (leave.toDate || leave.date || start);
  if (String(end) < monthStart || String(start) > monthEnd) return 0;
  return dateRangeISO(start, end).length;
}

function payrollAttendanceSummary(store, staff, monthKey) {
  const rows = (store.attendance || []).filter((row) => row.status !== 'Void' && row.date?.startsWith(monthKey) && (row.userId === staff.userId || row.userId === staff.id || row.staffName === staff.staffName));
  const presentDates = new Set(rows.filter((row) => row.checkInAt).map((row) => row.date));
  const completedDates = new Set(rows.filter((row) => row.checkInAt && row.checkOutAt).map((row) => row.date));
  const weeklyOffDates = dateRangeISO(monthStartISO(monthKey), monthEndISO(monthKey)).filter((date) => weekDayName(date) === staff.weeklyOffDay);
  const weeklyOffWorked = weeklyOffDates.filter((date) => presentDates.has(date));
  return {
    rows,
    presentDays: presentDates.size,
    completedDays: completedDates.size,
    weeklyOffCount: weeklyOffDates.length,
    weeklyOffWorked: weeklyOffWorked.length,
    weeklyOffWorkedDates: weeklyOffWorked
  };
}

function computeStaffPayroll(store, staff, monthKey = todayISO().slice(0, 7)) {
  const rules = normalizeSalaryRules(store.salaryRules || {});
  const daysInMonth = daysInPayrollMonth(monthKey);
  const baseSalary = toNumber(staff.baseSalary);
  const perDay = daysInMonth ? baseSalary / daysInMonth : 0;
  const attendance = payrollAttendanceSummary(store, staff, monthKey);
  const leaves = (store.leaveRequests || []).filter((leave) => (leave.staffId === staff.id || leave.staffId === staff.userId || leave.staffName === staff.staffName) && (leave.status || 'Approved') !== 'Cancelled');
  const approvedLeaves = leaves.filter((leave) => (leave.type || leave.leaveType) === 'Approved Leave');
  const unapprovedLeaves = leaves.filter((leave) => (leave.type || leave.leaveType) !== 'Approved Leave');
  const approvedLeaveDays = approvedLeaves.reduce((sum, leave) => sum + leaveDaysForMonth(leave, monthKey), 0);
  const declaredUnapprovedLeaveDays = unapprovedLeaves.reduce((sum, leave) => sum + leaveDaysForMonth(leave, monthKey), 0);
  const presentDateSet = new Set(attendance.rows.filter((row) => row.checkInAt).map((row) => row.date));
  const approvedLeaveSet = new Set(approvedLeaves.flatMap((leave) => dateRangeISO(
    String(leave.fromDate || leave.date || monthStartISO(monthKey)) < monthStartISO(monthKey) ? monthStartISO(monthKey) : (leave.fromDate || leave.date || monthStartISO(monthKey)),
    String(leave.toDate || leave.date || leave.fromDate || monthEndISO(monthKey)) > monthEndISO(monthKey) ? monthEndISO(monthKey) : (leave.toDate || leave.date || leave.fromDate || monthEndISO(monthKey))
  )));
  const declaredAbsentSet = new Set(unapprovedLeaves.flatMap((leave) => dateRangeISO(
    String(leave.fromDate || leave.date || monthStartISO(monthKey)) < monthStartISO(monthKey) ? monthStartISO(monthKey) : (leave.fromDate || leave.date || monthStartISO(monthKey)),
    String(leave.toDate || leave.date || leave.fromDate || monthEndISO(monthKey)) > monthEndISO(monthKey) ? monthEndISO(monthKey) : (leave.toDate || leave.date || leave.fromDate || monthEndISO(monthKey))
  )));
  const payrollDates = dateRangeISO(monthStartISO(monthKey), monthEndISO(monthKey));
  const autoAbsentDates = payrollDates.filter((date) => {
    const isWeeklyOff = weekDayName(date) === staff.weeklyOffDay;
    if (isWeeklyOff || presentDateSet.has(date) || approvedLeaveSet.has(date) || declaredAbsentSet.has(date)) return false;
    return true;
  });
  const autoAbsentDays = autoAbsentDates.length;
  const unapprovedLeaveDays = declaredUnapprovedLeaveDays + autoAbsentDays;
  const approvedDeduction = Math.round(approvedLeaveDays * perDay * toNumber(rules.approvedLeaveDeductionPercent) / 100);
  const unapprovedDeduction = Math.round(unapprovedLeaveDays * perDay * toNumber(rules.unapprovedLeaveDeductionPercent) / 100);
  const absenteePenalty = Math.round(unapprovedLeaveDays * toNumber(rules.absenteePenaltyPerDay));
  const allWeeklyOffsWorked = attendance.weeklyOffCount > 0 && attendance.weeklyOffWorked >= attendance.weeklyOffCount;
  const weeklyOffBonus = allWeeklyOffsWorked ? Math.round(toNumber(rules.weeklyOffBonusAmount)) : 0;
  const allowance = toNumber(staff.monthlyAllowance);
  const manualDeduction = toNumber(staff.monthlyDeduction);
  const gross = baseSalary + allowance + weeklyOffBonus;
  const totalDeductions = approvedDeduction + unapprovedDeduction + absenteePenalty + manualDeduction;
  const netSalary = Math.max(0, Math.round(gross - totalDeductions));
  return {
    staffId: staff.id,
    staffName: staff.staffName,
    role: staff.role,
    month: monthKey,
    daysInMonth,
    baseSalary,
    perDay: Math.round(perDay),
    presentDays: attendance.presentDays,
    completedDays: attendance.completedDays,
    weeklyOffDay: staff.weeklyOffDay,
    weeklyOffCount: attendance.weeklyOffCount,
    weeklyOffWorked: attendance.weeklyOffWorked,
    allWeeklyOffsWorked,
    weeklyOffBonus,
    approvedLeaveDays,
    autoAbsentDays,
    unapprovedLeaveDays,
    approvedDeduction,
    unapprovedDeduction,
    absenteePenalty,
    allowance,
    manualDeduction,
    gross,
    totalDeductions,
    netSalary,
    status: 'Draft'
  };
}

function makeAudit(action, area = 'System', user = 'Owner') {
  return { id: uid('AUD'), action, area, user, createdAt: new Date().toISOString() };
}

function classifyTask(task) {
  if (task.status === 'Done') return { label: 'Done', tone: 'green' };
  if (task.dueDate && new Date(task.dueDate + 'T00:00:00') < new Date(todayISO() + 'T00:00:00')) return { label: 'Overdue', tone: 'red' };
  if (task.dueDate === todayISO()) return { label: 'Due Today', tone: 'orange' };
  return { label: task.status || 'Open', tone: task.priority === 'High' ? 'orange' : 'blue' };
}

const taskFrequencies = ['One-time', 'Daily', 'Weekly', 'Bi-Monthly'];

function taskFrequencyLabel(value) {
  if (value === 'Bi-Monthly') return 'Bi-monthly / every 15 days';
  return value || 'One-time';
}

function isTaskOpen(task) {
  return task.status !== 'Done' && task.status !== 'Cancelled';
}

function isTaskDueForDaily(task, dateValue = todayISO()) {
  if (!isTaskOpen(task) || !task.dueDate) return false;
  return String(task.dueDate) <= String(dateValue);
}

function advanceTaskDueDate(dateValue, frequency) {
  const base = dateValue || todayISO();
  if (frequency === 'Daily') return addDaysISO(base, 1);
  if (frequency === 'Weekly') return addDaysISO(base, 7);
  if (frequency === 'Bi-Monthly') return addDaysISO(base, 15);
  return base;
}

function nextScheduledDateAfterToday(dateValue, frequency) {
  if (!frequency || frequency === 'One-time') return dateValue || todayISO();
  let next = advanceTaskDueDate(dateValue || todayISO(), frequency);
  let guard = 0;
  while (String(next) <= String(todayISO()) && guard < 80) {
    next = advanceTaskDueDate(next, frequency);
    guard += 1;
  }
  return next;
}

function normalizeTask(task = {}) {
  const frequency = task.frequency || task.scheduleType || 'One-time';
  return {
    ...task,
    frequency,
    autoCarryToDaily: task.autoCarryToDaily !== false,
    dueDate: task.dueDate || task.followUpDate || todayISO(),
    status: task.status || 'Open'
  };
}

function waLink(phone, text) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return '#';
  const number = clean.length === 10 ? `91${clean}` : clean;
  return `https://wa.me/${number}?text=${encodeURIComponent(text || '')}`;
}

function exportCsv(filename, rows) {
  if (!rows?.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildDataQuality(store) {
  const issues = [];
  for (const article of store.articles || []) {
    if (!article.articleCode) issues.push({ severity: 'High', area: 'Article Master', issue: `${article.articleName || 'Article'} has no article code`, action: 'Add a unique article code for issue/return tracking.' });
    if (!article.replacementCost) issues.push({ severity: 'Medium', area: 'Article Master', issue: `${article.articleName || 'Article'} has no replacement cost`, action: 'Add replacement cost for damage/lost recovery.' });
    if (!article.purchaseBill) issues.push({ severity: 'Low', area: 'Purchase Proof', issue: `${article.articleName || 'Article'} has no purchase bill attachment`, action: 'Upload bill photo/PDF for warranty/accounting.' });
    if (!article.maintenanceEveryDays) issues.push({ severity: 'Medium', area: 'Maintenance', issue: `${article.articleName || 'Article'} has no service interval`, action: 'Set service interval days.' });
  }
  for (const rental of store.rentals || []) {
    if (!rental.mobile) issues.push({ severity: 'High', area: 'Rental Issue', issue: `${rental.issueNo || 'Issue'} has no customer mobile`, action: 'Add phone before sending reminders.' });
    if (!rental.expectedReturnDate) issues.push({ severity: 'High', area: 'Rental Issue', issue: `${rental.issueNo || 'Issue'} has no return date`, action: 'Set return date to avoid casual holding.' });
    if (!rental.termsAccepted) issues.push({ severity: 'Medium', area: 'Terms', issue: `${rental.issueNo || 'Issue'} terms not accepted`, action: 'Get rental terms confirmation.' });
    if ((rental.beforePhotos || []).length === 0) issues.push({ severity: 'Medium', area: 'Condition Proof', issue: `${rental.issueNo || 'Issue'} has no before photo/video`, action: 'Upload before handover proof.' });
  }
  for (const inv of store.invoices || []) {
    if (invoiceBalance(inv, store.payments || []) > 0 && inv.dueDate && new Date(inv.dueDate + 'T00:00:00') < new Date(todayISO() + 'T00:00:00')) issues.push({ severity: 'High', area: 'Receivable', issue: `${inv.invoiceNo} payment is overdue`, action: 'Call customer and record follow-up task.' });
  }
  return issues;
}

function businessHealthScore(store) {
  const issues = buildDataQuality(store);
  const penalty = issues.reduce((sum, i) => sum + (i.severity === 'High' ? 8 : i.severity === 'Medium' ? 4 : 2), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function printDocument(title, html) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;margin:28px;color:#111}h1,h2{margin:0 0 8px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}.right{text-align:right}.terms{white-space:pre-line;margin-top:18px}.totals{margin-left:auto;width:320px}.muted{color:#666;font-size:12px}@media print{button{display:none}}</style></head><body>${html}<button onclick="window.print()">Print / Save PDF</button></body></html>`);
  win.document.close();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, source: 'local', dataUrl: reader.result, uploadedAt: new Date().toISOString() });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_MIME_FOLDER = 'application/vnd.google-apps.folder';
let gisScriptPromise = null;

function defaultSettings() {
  return {
    firmName: 'Urban Interior & Decor',
    receiptPrefix: 'ISS',
    quotePrefix: 'QT',
    invoicePrefix: 'INV',
    defaultGstPercent: 18,
    mediaStorage: 'googleDrive',
    authRequired: true,
    driveEnabled: false,
    driveClientId: '',
    driveFolderName: 'Rental Services OS',
    driveAutoUploadFiles: true,
    driveLocalFallback: false,
    driveBackupName: 'rental-services-backups',
    supabaseEnabled: true,
    supabaseUrl: '',
    supabaseAnonKey: '',
    supabaseSnapshotTable: 'rental_app_snapshots',
    supabaseSnapshotId: 'main',
    supabaseDataMode: 'relational',
    supabaseRelationalEnabled: true,
    supabaseAutoSyncData: true,
    supabaseLocalFallback: false,
    roleMode: 'Owner',
    advancedMode: true,
    approvalRequiredAbove: 5000,
    latePenaltyPerDay: 100,
    lowStockWarningQty: 1,
    salaryRules: defaultSalaryRules(),
    localCacheBusinessData: false
  };
}

function normalizeSettings(settings = {}) {
  return { ...defaultSettings(), ...settings };
}

function loadGisScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisScriptPromise) {
    gisScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Google Identity Services script failed to load'));
      document.head.appendChild(script);
    });
  }
  return gisScriptPromise;
}

function connectGoogleDrive(clientId) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!clientId?.trim()) throw new Error('Enter Google OAuth Web Client ID first');
      await loadGisScript();
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: DRIVE_SCOPE,
        prompt: 'consent',
        callback: (response) => {
          if (response?.error) return reject(new Error(response.error));
          resolve(response.access_token);
        }
      });
      tokenClient.requestAccessToken();
    } catch (error) {
      reject(error);
    }
  });
}

async function driveFetch(accessToken, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Drive request failed (${res.status})`);
  }
  return res.json();
}

function escapeDriveQuery(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateDriveFolder(accessToken, folderName, parentFolderId = 'root') {
  const safeName = escapeDriveQuery(folderName || 'Rental Services OS');
  const query = encodeURIComponent(`name='${safeName}' and mimeType='${DRIVE_MIME_FOLDER}' and trashed=false and '${parentFolderId}' in parents`);
  const search = await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,webViewLink)&spaces=drive`);
  if (search.files?.[0]) return search.files[0];
  return driveFetch(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName || 'Rental Services OS', mimeType: DRIVE_MIME_FOLDER, parents: [parentFolderId] })
  });
}

async function uploadBlobToDrive({ accessToken, blob, fileName, mimeType, folderName, subFolderName }) {
  if (!accessToken) throw new Error('Google Drive is not connected');
  const rootFolder = await findOrCreateDriveFolder(accessToken, folderName || 'Rental Services OS');
  const finalFolder = subFolderName ? await findOrCreateDriveFolder(accessToken, subFolderName, rootFolder.id) : rootFolder;
  const metadata = { name: fileName, parents: [finalFolder.id] };
  const boundary = `rental_os_${Date.now()}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  const body = new Blob([
    delimiter,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    delimiter,
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
    blob,
    closeDelimiter
  ], { type: `multipart/related; boundary=${boundary}` });

  const uploaded = await driveFetch(accessToken, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  return {
    name: uploaded.name || fileName,
    type: uploaded.mimeType || mimeType || '',
    size: Number(uploaded.size || blob.size || 0),
    source: 'googleDrive',
    driveFileId: uploaded.id,
    driveWebViewLink: uploaded.webViewLink,
    driveWebContentLink: uploaded.webContentLink,
    driveFolderId: finalFolder.id,
    driveFolderName: finalFolder.name,
    uploadedAt: new Date().toISOString()
  };
}


function sanitizeFileName(value = 'file') {
  return String(value || 'file').replace(/[^a-z0-9_.-]/gi, '-').replace(/-+/g, '-').slice(0, 140);
}

function sanitizeFolderName(value = 'folder') {
  return String(value || 'folder').replace(/[^a-z0-9 _.-]/gi, '').trim() || 'folder';
}

function getSupabaseClient(settings = {}) {
  const url = settings.supabaseUrl?.trim();
  const anonKey = settings.supabaseAnonKey?.trim();
  if (!isValidSupabaseUrl(url)) throw new Error('Enter a valid Supabase Project URL like https://xxxx.supabase.co');
  if (!isValidSupabasePublicKey(anonKey)) throw new Error('Enter a valid Supabase publishable/anon public key. Do not use service_role or database password.');
  return createClient(url, anonKey);
}

function publicSafeSettings(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    ...normalized,
    driveClientId: '',
    supabaseAnonKey: '',
    supabaseUrl: ''
  };
}

function storeForSupabase(store = {}, authProfile = null) {
  return {
    articles: store.articles || [],
    customers: store.customers || [],
    quotations: store.quotations || [],
    invoices: store.invoices || [],
    expenses: store.expenses || [],
    vendors: store.vendors || [],
    purchaseOrders: store.purchaseOrders || [],
    tasks: store.tasks || [],
    movements: store.movements || [],
    staffProfiles: store.staffProfiles || [],
    leaveRequests: store.leaveRequests || [],
    payrollRuns: store.payrollRuns || [],
    salaryRules: normalizeSalaryRules(store.salaryRules || store.settings?.salaryRules || {}),
    audit: store.audit || [],
    rentals: store.rentals || [],
    returns: store.returns || [],
    payments: store.payments || [],
    repairs: store.repairs || [],
    attendance: store.attendance || [],
    settings: publicSafeSettings(store.settings || {}),
    syncedBy: authProfile ? { id: authProfile.id, name: authProfile.full_name, role: authProfile.role } : null,
    syncedAt: new Date().toISOString(),
    schemaVersion: 2
  };
}

function normalizeImportedStore(parsed = {}, currentSettings = {}) {
  const incomingSettings = normalizeSettings(parsed.settings || {});
  const mergedSettings = normalizeSettings({
    ...incomingSettings,
    ...currentSettings,
    firmName: incomingSettings.firmName || currentSettings.firmName,
    receiptPrefix: incomingSettings.receiptPrefix || currentSettings.receiptPrefix
  });
  return {
    articles: Array.isArray(parsed.articles) ? parsed.articles : [],
    customers: Array.isArray(parsed.customers) ? parsed.customers : [],
    quotations: Array.isArray(parsed.quotations) ? parsed.quotations : [],
    invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [],
    expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
    vendors: Array.isArray(parsed.vendors) ? parsed.vendors : [],
    purchaseOrders: Array.isArray(parsed.purchaseOrders) ? parsed.purchaseOrders : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    movements: Array.isArray(parsed.movements) ? parsed.movements : [],
    staffProfiles: Array.isArray(parsed.staffProfiles) ? parsed.staffProfiles : [],
    leaveRequests: Array.isArray(parsed.leaveRequests) ? parsed.leaveRequests : [],
    payrollRuns: Array.isArray(parsed.payrollRuns) ? parsed.payrollRuns : [],
    salaryRules: normalizeSalaryRules(parsed.salaryRules || parsed.settings?.salaryRules || {}),
    audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    rentals: Array.isArray(parsed.rentals) ? parsed.rentals : [],
    returns: Array.isArray(parsed.returns) ? parsed.returns : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : [],
    repairs: Array.isArray(parsed.repairs) ? parsed.repairs : [],
    attendance: Array.isArray(parsed.attendance) ? parsed.attendance : [],
    settings: mergedSettings
  };
}

async function saveStoreToSupabase({ client, store, settings, authProfile = null }) {
  if (!client) throw new Error('Connect Supabase first');
  const relationalPreferred = settings.supabaseRelationalEnabled !== false && settings.supabaseDataMode !== 'snapshot';
  if (relationalPreferred) {
    try {
      return await saveStoreToRelationalSupabase({ client, store, authProfile });
    } catch (relationalError) {
      console.warn('Relational Supabase save failed; falling back to snapshot:', relationalError.message || relationalError);
      if (settings.supabaseLocalFallback === false) throw relationalError;
    }
  }
  const table = settings.supabaseSnapshotTable || 'rental_app_snapshots';
  const id = settings.supabaseSnapshotId || 'main';
  const payload = storeForSupabase(store, authProfile);
  const { error } = await client
    .from(table)
    .upsert({ id, payload, updated_by: authProfile?.id || null, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
  return { id, updatedAt: payload.syncedAt, mode: 'snapshot-fallback' };
}

async function loadStoreFromSupabase({ client, settings }) {
  if (!client) throw new Error('Connect Supabase first');
  const relationalPreferred = settings.supabaseRelationalEnabled !== false && settings.supabaseDataMode !== 'snapshot';
  if (relationalPreferred) {
    try {
      return await loadStoreFromRelationalSupabase({ client, settings });
    } catch (relationalError) {
      console.warn('Relational Supabase load failed; trying snapshot:', relationalError.message || relationalError);
    }
  }
  const table = settings.supabaseSnapshotTable || 'rental_app_snapshots';
  const id = settings.supabaseSnapshotId || 'main';
  const { data, error } = await client
    .from(table)
    .select('id,payload,updated_at')
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  if (!data?.[0]?.payload) throw new Error('No Supabase backup/snapshot found for this ID');
  return data[0];
}

async function testSupabaseConnection({ client, settings }) {
  const table = settings.supabaseSnapshotTable || 'rental_app_snapshots';
  const { error } = await client.from(table).select('id,updated_at').limit(1);
  if (error) throw error;
  return true;
}

const RELATIONAL_TABLES = {
  articles: 'rental_articles',
  customers: 'rental_customers',
  quotations: 'rental_quotations',
  invoices: 'rental_invoices',
  expenses: 'rental_expenses',
  vendors: 'rental_vendors',
  purchaseOrders: 'rental_purchase_orders',
  tasks: 'rental_tasks',
  movements: 'rental_movements',
  staffProfiles: 'rental_staff_profiles',
  leaveRequests: 'rental_leave_requests',
  payrollRuns: 'rental_payroll_runs',
  audit: 'rental_audit_logs',
  rentals: 'rental_issues',
  returns: 'rental_returns',
  payments: 'rental_payments',
  repairs: 'rental_repairs',
  attendance: 'rental_attendance'
};

function inferRecordOwner(row = {}, fallbackUserId = null) {
  return row.userId || row.staffUserId || row.createdById || row.assignedUserId || row.ownerId || fallbackUserId || null;
}

function inferAssignedTo(row = {}) {
  return row.assignedTo || row.staffName || row.issuedBy || row.receivedBy || row.createdBy || '';
}

function recordToRelationalRow(domain, row = {}, authProfile = null) {
  const now = new Date().toISOString();
  const recordId = row.id || row.record_id || uid(domain.slice(0, 3).toUpperCase());
  const data = { ...row, id: recordId };
  return {
    record_id: recordId,
    record_data: data,
    customer_id: row.customerId || row.customer_id || '',
    article_id: row.articleId || row.article_id || '',
    rental_id: row.rentalId || row.rental_id || '',
    invoice_id: row.invoiceId || row.invoice_id || '',
    task_id: row.taskId || row.proofForTaskId || '',
    record_owner: inferRecordOwner(row, authProfile?.id || null),
    assigned_to: inferAssignedTo(row),
    status: row.status || row.conditionAfter || row.paymentStatus || '',
    updated_by: authProfile?.id || null,
    updated_at: now
  };
}

async function upsertDomainRows(client, domain, rows = [], authProfile = null) {
  const table = RELATIONAL_TABLES[domain];
  if (!table) return { count: 0 };
  const payload = (rows || []).map((row) => recordToRelationalRow(domain, row, authProfile));
  if (!payload.length) return { count: 0 };
  const { error } = await client.from(table).upsert(payload, { onConflict: 'record_id' });
  if (error) throw error;
  return { count: payload.length };
}

async function saveStoreToRelationalSupabase({ client, store, authProfile = null }) {
  if (!client) throw new Error('Connect Supabase first');
  const payload = storeForSupabase(store, authProfile);
  const domains = Object.keys(RELATIONAL_TABLES).filter((key) => Array.isArray(payload[key]));
  const results = {};
  for (const domain of domains) {
    results[domain] = await upsertDomainRows(client, domain, payload[domain], authProfile);
  }
  if (payload.salaryRules) {
    const { error } = await client.from('rental_system_settings').upsert({
      record_id: 'salaryRules',
      record_data: payload.salaryRules,
      updated_by: authProfile?.id || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'record_id' });
    if (error) throw error;
  }
  return { id: 'relational', updatedAt: new Date().toISOString(), results };
}

async function loadDomainRows(client, domain) {
  const table = RELATIONAL_TABLES[domain];
  if (!table) return [];
  const { data, error } = await client.from(table).select('record_data,updated_at').order('updated_at', { ascending: false }).limit(5000);
  if (error) throw error;
  const seen = new Set();
  const rows = [];
  for (const row of data || []) {
    const record = row.record_data || {};
    const id = record.id || record.record_id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    rows.push(record);
  }
  return rows;
}

async function loadStoreFromRelationalSupabase({ client, settings = {} }) {
  if (!client) throw new Error('Connect Supabase first');
  const loaded = {};
  let totalRows = 0;
  for (const domain of Object.keys(RELATIONAL_TABLES)) {
    loaded[domain] = await loadDomainRows(client, domain);
    totalRows += loaded[domain].length;
  }
  let salaryRules = null;
  const { data: settingsRows } = await client.from('rental_system_settings').select('record_data').eq('record_id', 'salaryRules').limit(1).catch(() => ({ data: [] }));
  if (settingsRows?.[0]?.record_data) salaryRules = settingsRows[0].record_data;
  if (!totalRows) throw new Error('No relational Supabase records found');
  return {
    id: 'relational',
    updated_at: new Date().toISOString(),
    payload: normalizeImportedStore({ ...loaded, salaryRules, settings: publicSafeSettings(settings) }, settings)
  };
}

async function persistMediaMetadata({ client, file, context = {}, authProfile = null }) {
  if (!client || !file?.driveFileId) return null;
  const row = {
    drive_file_id: file.driveFileId,
    record_type: context.recordType || context.area || context.label || 'Media',
    record_id: context.recordId || context.ownerId || '',
    owner_table: context.ownerTable || '',
    owner_field: context.ownerField || '',
    file_name: file.name || '',
    mime_type: file.type || '',
    size_bytes: Number(file.size || 0),
    drive_web_view_link: file.driveWebViewLink || '',
    drive_web_content_link: file.driveWebContentLink || '',
    drive_folder_id: file.driveFolderId || '',
    metadata: { ...file, context },
    uploaded_by: authProfile?.id || null,
    uploaded_at: file.uploadedAt || new Date().toISOString()
  };
  const { error } = await client.from('media_files').upsert(row, { onConflict: 'drive_file_id' });
  if (error) throw error;
  return row;
}


async function fetchAppUserProfile(client, user) {
  if (!client || !user?.id) throw new Error('Supabase login session not found');
  const { data, error } = await client
    .from('app_users')
    .select('id,email,full_name,role,status,created_at,updated_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    if (data.status && data.status !== 'Active') throw new Error('This user account is inactive. Ask owner to activate it.');
    return data;
  }
  const fallback = {
    id: user.id,
    email: user.email || '',
    full_name: user.user_metadata?.full_name || user.email || 'Staff User',
    role: 'Field Staff',
    status: 'Active'
  };
  const { data: inserted, error: insertError } = await client.from('app_users').insert(fallback).select('id,email,full_name,role,status,created_at,updated_at').single();
  if (insertError) throw insertError;
  return inserted;
}

function roleAdvancedDefault(role) {
  return role === 'Owner' || role === 'Operations Manager';
}

function applyRoleToStoreSettings(prev, profile) {
  const role = profile?.role || 'Field Staff';
  return {
    ...prev,
    settings: normalizeSettings({ ...prev.settings, roleMode: role, advancedMode: roleAdvancedDefault(role) })
  };
}

function fileUrl(file) {
  if (!file) return '';
  return file.driveWebViewLink || file.supabasePublicUrl || file.webViewLink || file.dataUrl || '';
}

function fileSourceLabel(file) {
  if (!file) return '';
  if (file.source === 'googleDrive') return 'Google Drive';
  if (file.source === 'supabase') return 'Supabase';
  return 'Local';
}

function FileLink({ file, label = 'View file' }) {
  const href = fileUrl(file);
  if (!href) return <span>-</span>;
  return <a href={href} target="_blank" rel="noreferrer" download={file.source === 'local' ? file.name : undefined}>{label} <small>({fileSourceLabel(file)})</small></a>;
}

function collectAttachedFiles(store) {
  const files = [];
  for (const a of store.articles || []) {
    if (a.photo) files.push({ area: 'Article Photo', owner: a.articleName, file: a.photo, path: { type: 'articlePhoto', articleId: a.id } });
    if (a.purchaseBill) files.push({ area: 'Purchase Bill', owner: a.articleName, file: a.purchaseBill, path: { type: 'articleBill', articleId: a.id } });
  }
  for (const r of store.rentals || []) {
    if (r.idProof) files.push({ area: 'ID Proof', owner: r.issueNo, file: r.idProof, path: { type: 'rentalIdProof', rentalId: r.id } });
    for (const [index, f] of (r.beforePhotos || []).entries()) files.push({ area: 'Before Photo/Video', owner: r.issueNo, file: f, path: { type: 'rentalBeforePhoto', rentalId: r.id, index } });
  }
  for (const ret of store.returns || []) {
    for (const [index, f] of (ret.afterPhotos || []).entries()) files.push({ area: 'After Return Photo/Video', owner: ret.rentalId, file: f, path: { type: 'returnAfterPhoto', returnId: ret.id, index } });
  }
  for (const rep of store.repairs || []) {
    if (rep.bill) files.push({ area: 'Repair Bill', owner: rep.reason, file: rep.bill, path: { type: 'repairBill', repairId: rep.id } });
  }
  for (const task of store.tasks || []) {
    for (const [index, f] of (task.proofFiles || []).entries()) files.push({ area: 'Task Work Proof', owner: task.title, file: f, path: { type: 'taskProof', taskId: task.id, index } });
    for (const [historyIndex, h] of (task.completedHistory || []).entries()) {
      for (const [fileIndex, f] of (h.files || []).entries()) files.push({ area: 'Task Completed Proof', owner: `${task.title} · ${h.by || ''}`, file: f, path: { type: 'taskProofHistory', taskId: task.id, historyIndex, fileIndex } });
    }
  }
  return files;
}


function normalizePhone(value = '') {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function normalizeName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function customerMatchesRecord(customer, record = {}) {
  if (!customer || !record) return false;
  const cPhone = normalizePhone(customer.mobile);
  const rPhone = normalizePhone(record.mobile || record.customerMobile || record.phone);
  if (record.customerId && customer.id && record.customerId === customer.id) return true;
  if (cPhone && rPhone && cPhone === rPhone) return true;
  const cName = normalizeName(customer.name);
  const rName = normalizeName(record.customerName || record.name || record.recoveredFrom);
  return Boolean(cName && rName && cName === rName);
}

function rentalClosed(rental = {}) {
  return toNumber(rental.quantityReturned) >= toNumber(rental.quantity) || ['Closed', 'Returned', 'Cancelled'].includes(rental.status);
}

function buildCustomer360Data(store = {}, customer) {
  if (!customer) {
    return { rentals: [], returns: [], invoices: [], quotations: [], payments: [], repairs: [], media: [], risk: { score: 0, label: 'No Customer', tone: 'gray', reasons: [] }, ledger: [] };
  }
  const rentals = (store.rentals || []).filter((r) => customerMatchesRecord(customer, r));
  const rentalIds = new Set(rentals.map((r) => r.id));
  const invoices = (store.invoices || []).filter((inv) => customerMatchesRecord(customer, inv) || (inv.rentalId && rentalIds.has(inv.rentalId)));
  const invoiceIds = new Set(invoices.map((inv) => inv.id));
  const quotations = (store.quotations || []).filter((q) => customerMatchesRecord(customer, q));
  const returns = (store.returns || []).filter((ret) => rentalIds.has(ret.rentalId));
  const payments = (store.payments || []).filter((p) => rentalIds.has(p.rentalId) || invoiceIds.has(p.invoiceId) || customerMatchesRecord(customer, p));
  const repairs = (store.repairs || []).filter((rep) => customerMatchesRecord(customer, { recoveredFrom: rep.recoveredFrom }) || rentals.some((r) => r.articleId === rep.articleId && customerMatchesRecord(customer, r)));
  const tasks = (store.tasks || []).filter((task) => customerMatchesRecord(customer, task) || (task.linkedType === 'Customer' && task.linkedId === customer.id) || (task.linkedType === 'Rental' && rentalIds.has(task.linkedId)) || (task.linkedType === 'Invoice' && invoiceIds.has(task.linkedId)));
  const articleMap = Object.fromEntries((store.articles || []).map((a) => [a.id, a]));
  const returnsByRental = Object.fromEntries(returns.map((ret) => [ret.rentalId, ret]));
  const paid = payments.filter((p) => p.type !== 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
  const refunds = payments.filter((p) => p.type === 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
  const invoiceTotal = invoices.reduce((s, inv) => s + computeDocTotals(inv.items || [], inv).grandTotal, 0);
  const active = rentals.filter((r) => !rentalClosed(r));
  const overdue = active.filter((r) => overdueDays(r.expectedReturnDate) > 0);
  const damageCases = returns.filter((ret) => toNumber(ret.damageDeduction) > 0 || ret.damageDescription || ret.conditionAfter === 'Damaged').length;
  const missingOrLost = returns.filter((ret) => toNumber(ret.quantityMissing) > 0 || ret.conditionAfter === 'Lost').length;
  const balance = Math.max(0, invoiceTotal - paid);
  const reasons = [];
  let score = 100;
  if (overdue.length) { score -= overdue.length * 12; reasons.push(`${overdue.length} overdue rental(s)`); }
  if (damageCases) { score -= damageCases * 10; reasons.push(`${damageCases} damage/deduction case(s)`); }
  if (missingOrLost) { score -= missingOrLost * 18; reasons.push(`${missingOrLost} missing/lost return case(s)`); }
  if (balance > 0) { score -= Math.min(30, Math.ceil(balance / 1000) * 4); reasons.push(`${money(balance)} receivable balance`); }
  if (!rentals.length && !invoices.length) { score = 70; reasons.push('No rental history yet'); }
  score = Math.max(0, Math.min(100, score));
  const risk = { score, label: score >= 80 ? 'Low Risk' : score >= 55 ? 'Medium Risk' : 'High Risk', tone: score >= 80 ? 'green' : score >= 55 ? 'orange' : 'red', reasons };
  const media = [];
  for (const r of rentals) {
    const articleName = r.articleSnapshot || articleMap[r.articleId]?.articleName || 'Article';
    if (r.idProof) media.push({ id: `${r.id}-id`, area: 'ID Proof', owner: `${r.issueNo} · ${r.customerName}`, articleName, file: r.idProof, date: r.issueDate });
    for (const [index, f] of (r.beforePhotos || []).entries()) media.push({ id: `${r.id}-before-${index}`, area: 'Before Issue Proof', owner: `${r.issueNo} · ${articleName}`, articleName, file: f, date: r.issueDate });
  }
  for (const ret of returns) {
    const rental = rentals.find((r) => r.id === ret.rentalId);
    const articleName = rental?.articleSnapshot || articleMap[ret.articleId]?.articleName || 'Article';
    for (const [index, f] of (ret.afterPhotos || []).entries()) media.push({ id: `${ret.id}-after-${index}`, area: 'After Return Proof', owner: `${rental?.issueNo || ret.rentalId} · ${articleName}`, articleName, file: f, date: ret.returnDate });
  }
  for (const rep of repairs) {
    if (rep.bill) media.push({ id: `${rep.id}-bill`, area: 'Repair Bill', owner: `${rep.reason || 'Repair'} · ${articleMap[rep.articleId]?.articleName || 'Article'}`, articleName: articleMap[rep.articleId]?.articleName || 'Article', file: rep.bill, date: rep.repairDate });
  }
  for (const task of tasks) {
    for (const [index, f] of (task.proofFiles || []).entries()) media.push({ id: `${task.id}-task-proof-${index}`, area: 'Task Work Proof', owner: `${task.title} · ${task.proofUpdatedBy || task.assignedTo || ''}`, articleName: task.linkedType || 'Task', file: f, date: task.proofUpdatedAt || task.dueDate });
    for (const [historyIndex, h] of (task.completedHistory || []).entries()) {
      if (h.text) media.push({ id: `${task.id}-task-proof-text-${historyIndex}`, area: 'Task Text Proof', owner: `${task.title} · ${h.by || ''}`, articleName: task.linkedType || 'Task', text: h.text, date: h.date });
      for (const [fileIndex, f] of (h.files || []).entries()) media.push({ id: `${task.id}-task-proof-history-${historyIndex}-${fileIndex}`, area: 'Completed Task Proof', owner: `${task.title} · ${h.by || ''}`, articleName: task.linkedType || 'Task', file: f, date: h.date });
    }
  }
  const ledger = [
    ...invoices.map((inv) => ({ id: `inv-${inv.id}`, date: inv.invoiceDate, type: 'Invoice', ref: inv.invoiceNo, debit: computeDocTotals(inv.items || [], inv).grandTotal, credit: 0, note: inv.siteName || inv.status })),
    ...payments.map((p) => ({ id: `pay-${p.id}`, date: p.date, type: p.type, ref: p.invoiceId ? invoices.find((i) => i.id === p.invoiceId)?.invoiceNo || 'Invoice' : p.rentalId ? rentals.find((r) => r.id === p.rentalId)?.issueNo || 'Rental' : '-', debit: p.type === 'Deposit Refund' ? toNumber(p.amount) : 0, credit: p.type === 'Deposit Refund' ? 0 : toNumber(p.amount), note: p.notes || p.mode }))
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { rentals, returns, invoices, quotations, payments, repairs, tasks, media, risk, ledger, totals: { invoiceTotal, paid, refunds, balance, active: active.length, overdue: overdue.length, damageCases, missingOrLost }, articleMap, returnsByRental };
}

function buildArticle360Data(store = {}, article) {
  if (!article) {
    return {
      rentals: [], activeRentals: [], returns: [], payments: [], repairs: [], media: [], ledger: [], quotations: [], invoices: [], movements: [], expenses: [], purchaseOrders: [], risk: { score: 0, label: 'No Article', tone: 'gray', reasons: [] }, totals: {}
    };
  }
  const rentals = (store.rentals || []).filter((r) => r.articleId === article.id);
  const rentalIds = new Set(rentals.map((r) => r.id));
  const returns = (store.returns || []).filter((ret) => rentalIds.has(ret.rentalId) || ret.articleId === article.id);
  const returnIds = new Set(returns.map((ret) => ret.id));
  const quotations = (store.quotations || []).filter((q) => (q.items || []).some((it) => it.articleId === article.id));
  const invoices = (store.invoices || []).filter((inv) => inv.articleId === article.id || rentalIds.has(inv.rentalId) || (inv.items || []).some((it) => it.articleId === article.id));
  const invoiceIds = new Set(invoices.map((inv) => inv.id));
  const payments = (store.payments || []).filter((p) => p.articleId === article.id || rentalIds.has(p.rentalId) || invoiceIds.has(p.invoiceId));
  const tasks = (store.tasks || []).filter((task) => (task.linkedType === 'Article' && task.linkedId === article.id) || (task.linkedType === 'Rental' && rentalIds.has(task.linkedId)) || (task.linkedType === 'Invoice' && invoiceIds.has(task.linkedId)));
  const repairs = (store.repairs || []).filter((rep) => rep.articleId === article.id);
  const movements = (store.movements || []).filter((m) => rentalIds.has(m.rentalId) || normalizeName(m.articleName) === normalizeName(article.articleName));
  const expenses = (store.expenses || []).filter((e) => e.linkedArticleId === article.id || rentalIds.has(e.linkedRentalId));
  const purchaseOrders = (store.purchaseOrders || []).filter((po) => po.linkedArticleId === article.id || normalizeName(po.item).includes(normalizeName(article.articleName)));
  const returnsByRental = Object.fromEntries(returns.map((ret) => [ret.rentalId, ret]));
  const activeRentals = rentals.filter((r) => !rentalClosed(r));
  const currentCustody = activeRentals.map((r) => ({
    rental: r,
    outstanding: Math.max(0, toNumber(r.quantity) - toNumber(r.quantityReturned)),
    lateDays: overdueDays(r.expectedReturnDate),
    movement: movements.find((m) => m.rentalId === r.id)
  }));

  const depositCollected = payments.filter((p) => p.type === 'Deposit Collected').reduce((s, p) => s + toNumber(p.amount), 0);
  const depositRefunded = payments.filter((p) => p.type === 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
  const rentEarned = payments.filter((p) => !['Deposit Collected', 'Deposit Refund', 'Damage Deducted From Deposit', 'Damage Deduction'].includes(p.type)).reduce((s, p) => s + toNumber(p.amount), 0);
  const repairCost = repairs.reduce((s, r) => s + toNumber(r.repairCost), 0);
  const repairRecovered = repairs.reduce((s, r) => s + toNumber(r.costRecovered), 0);
  const damageRecovered = returns.reduce((s, r) => s + toNumber(r.damageDeduction), 0) + repairRecovered;
  const expenseTotal = expenses.reduce((s, e) => s + toNumber(e.amount), 0);
  const purchaseCost = toNumber(article.purchaseCost);
  const netProfit = Math.round(rentEarned + damageRecovered - repairCost - expenseTotal - purchaseCost);
  const overdue = currentCustody.filter((c) => c.lateDays > 0);
  const damageCases = returns.filter((ret) => toNumber(ret.damageDeduction) > 0 || ret.damageDescription || ret.conditionAfter === 'Damaged').length + repairs.length;
  const missingOrLost = returns.filter((ret) => toNumber(ret.quantityMissing) > 0 || ret.conditionAfter === 'Lost').length + (article.status === 'Lost' ? 1 : 0);
  const utilizationCount = rentals.length;
  const reasons = [];
  let score = 100;
  if (article.status === 'Lost' || article.status === 'Retired') { score -= 35; reasons.push(`Article status is ${article.status}`); }
  if (['In Repair', 'Damaged'].includes(article.status)) { score -= 22; reasons.push(`Not rentable: ${article.status}`); }
  if (overdue.length) { score -= overdue.length * 12; reasons.push(`${overdue.length} overdue custody record(s)`); }
  if (damageCases) { score -= Math.min(30, damageCases * 8); reasons.push(`${damageCases} damage/repair case(s)`); }
  if (missingOrLost) { score -= Math.min(25, missingOrLost * 15); reasons.push(`${missingOrLost} missing/lost case(s)`); }
  if (purchaseCost && rentEarned < purchaseCost * 0.5 && utilizationCount > 0) { score -= 8; reasons.push('Payback still low compared to purchase cost'); }
  if (!utilizationCount) { score = Math.min(score, 75); reasons.push('No rental history yet'); }
  score = Math.max(0, Math.min(100, score));
  const risk = { score, label: score >= 80 ? 'Healthy Article' : score >= 55 ? 'Watch Article' : 'High Risk Article', tone: score >= 80 ? 'green' : score >= 55 ? 'orange' : 'red', reasons };

  const media = [];
  if (article.photo) media.push({ id: `${article.id}-photo`, area: 'Article Photo', owner: `${article.articleCode} · ${article.articleName}`, file: article.photo, date: article.purchaseDate || article.createdAt });
  if (article.purchaseBill) media.push({ id: `${article.id}-bill`, area: 'Purchase Bill', owner: `${article.articleCode} · ${article.vendorName || 'Vendor'}`, file: article.purchaseBill, date: article.purchaseDate || article.createdAt });
  for (const r of rentals) {
    if (r.idProof) media.push({ id: `${r.id}-id`, area: 'ID Proof', owner: `${r.issueNo} · ${r.customerName}`, file: r.idProof, date: r.issueDate });
    for (const [index, f] of (r.beforePhotos || []).entries()) media.push({ id: `${r.id}-before-${index}`, area: 'Before Issue Proof', owner: `${r.issueNo} · ${r.customerName}`, file: f, date: r.issueDate });
  }
  for (const ret of returns) {
    const rental = rentals.find((r) => r.id === ret.rentalId);
    for (const [index, f] of (ret.afterPhotos || []).entries()) media.push({ id: `${ret.id}-after-${index}`, area: 'After Return Proof', owner: `${rental?.issueNo || ret.rentalId} · ${ret.conditionAfter || 'Return'}`, file: f, date: ret.returnDate });
  }
  for (const rep of repairs) {
    if (rep.bill) media.push({ id: `${rep.id}-repair-bill`, area: 'Repair Bill', owner: `${rep.issueType || 'Repair'} · ${rep.mechanicVendor || '-'}`, file: rep.bill, date: rep.repairDate });
  }

  for (const task of tasks) {
    for (const [index, f] of (task.proofFiles || []).entries()) media.push({ id: `${task.id}-task-proof-${index}`, area: 'Task Work Proof', owner: `${task.title} · ${task.proofUpdatedBy || task.assignedTo || ''}`, file: f, date: task.proofUpdatedAt || task.dueDate });
    for (const [historyIndex, h] of (task.completedHistory || []).entries()) {
      for (const [fileIndex, f] of (h.files || []).entries()) media.push({ id: `${task.id}-task-proof-history-${historyIndex}-${fileIndex}`, area: 'Completed Task Proof', owner: `${task.title} · ${h.by || ''}`, file: f, date: h.date });
    }
  }
  const ledger = [
    ...rentals.map((r) => ({ id: `ren-${r.id}`, date: r.issueDate, type: 'Issued', ref: r.issueNo, debit: 0, credit: 0, note: `${r.customerName} · Qty ${r.quantity} · Due ${fmtDate(r.expectedReturnDate)}` })),
    ...returns.map((ret) => ({ id: `ret-${ret.id}`, date: ret.returnDate, type: 'Returned', ref: rentals.find((r) => r.id === ret.rentalId)?.issueNo || ret.rentalId, debit: toNumber(ret.damageDeduction) + toNumber(ret.latePenalty), credit: 0, note: `${ret.conditionAfter || 'Return'} · ${ret.damageDescription || ret.notes || '-'}` })),
    ...payments.map((p) => ({ id: `pay-${p.id}`, date: p.date, type: p.type, ref: p.invoiceId ? invoices.find((i) => i.id === p.invoiceId)?.invoiceNo || 'Invoice' : p.rentalId ? rentals.find((r) => r.id === p.rentalId)?.issueNo || 'Rental' : '-', debit: p.type === 'Deposit Refund' ? toNumber(p.amount) : 0, credit: p.type === 'Deposit Refund' ? 0 : toNumber(p.amount), note: p.notes || p.mode })),
    ...repairs.map((rep) => ({ id: `rep-${rep.id}`, date: rep.repairDate, type: rep.issueType || 'Repair', ref: rep.mechanicVendor || '-', debit: toNumber(rep.repairCost), credit: toNumber(rep.costRecovered), note: rep.reason || rep.notes || '-' })),
    ...expenses.map((exp) => ({ id: `exp-${exp.id}`, date: exp.date, type: `Expense · ${exp.category}`, ref: exp.paidTo || '-', debit: toNumber(exp.amount), credit: 0, note: exp.notes || exp.mode || '-' }))
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return { rentals, activeRentals, returns, payments, repairs, media, ledger, quotations, invoices, movements, expenses, purchaseOrders, currentCustody, returnsByRental, risk, totals: { depositCollected, depositRefunded, rentEarned, repairCost, repairRecovered, damageRecovered, expenseTotal, purchaseCost, netProfit, overdue: overdue.length, damageCases, missingOrLost, utilizationCount } };
}

async function dataUrlToFile(fileRecord, fallbackName = 'attachment') {
  if (!fileRecord?.dataUrl) throw new Error('Only local data URL files can be migrated');
  const res = await fetch(fileRecord.dataUrl);
  const blob = await res.blob();
  return new File([blob], fileRecord.name || fallbackName, { type: fileRecord.type || blob.type || 'application/octet-stream' });
}

function replaceAttachmentInStore(store, path, uploaded) {
  if (!path) return store;
  if (path.type === 'articlePhoto') return { ...store, articles: store.articles.map((a) => a.id === path.articleId ? { ...a, photo: uploaded } : a) };
  if (path.type === 'articleBill') return { ...store, articles: store.articles.map((a) => a.id === path.articleId ? { ...a, purchaseBill: uploaded } : a) };
  if (path.type === 'rentalIdProof') return { ...store, rentals: store.rentals.map((r) => r.id === path.rentalId ? { ...r, idProof: uploaded } : r) };
  if (path.type === 'rentalBeforePhoto') return { ...store, rentals: store.rentals.map((r) => r.id === path.rentalId ? { ...r, beforePhotos: (r.beforePhotos || []).map((f, i) => i === path.index ? uploaded : f) } : r) };
  if (path.type === 'returnAfterPhoto') return { ...store, returns: store.returns.map((r) => r.id === path.returnId ? { ...r, afterPhotos: (r.afterPhotos || []).map((f, i) => i === path.index ? uploaded : f) } : r) };
  if (path.type === 'repairBill') return { ...store, repairs: store.repairs.map((r) => r.id === path.repairId ? { ...r, bill: uploaded } : r) };
  return store;
}

function emptyForm() {
  return {
    articleType: 'Construction Tool',
    category: '',
    subcategory: '',
    articleName: '',
    articleCode: '',
    brand: '',
    modelSize: '',
    serialNumber: '',
    purchaseDate: todayISO(),
    purchaseCost: '',
    qtyTotal: 1,
    currentLocation: 'Shop',
    condition: 'Good',
    status: 'Available',
    rentUnit: 'Day',
    rentRate: '',
    depositDefault: '',
    replacementCost: '',
    vendorName: '',
    warrantyTill: '',
    accessoriesText: '',
    notes: '',
    maintenanceEveryDays: 30,
    photo: null,
    purchaseBill: null
  };
}

function seedStore() {
  const a1 = {
    id: uid('ART'), articleType: 'Construction Tool', category: 'Electrical Tool', subcategory: 'Drilling', articleName: 'Bosch Drill Machine', articleCode: 'TOOL-DRILL-001', brand: 'Bosch', modelSize: '13mm', serialNumber: 'BD-13-001', purchaseDate: '2026-05-20', purchaseCost: 4500, qtyTotal: 4, currentLocation: 'Shop', condition: 'Good', status: 'Available', rentUnit: 'Day', rentRate: 200, depositDefault: 1000, replacementCost: 4500, vendorName: 'Tool Market', warrantyTill: '2027-05-20', accessories: ['Chuck key', 'Drill bits', 'Handle', 'Box'], notes: 'Check wire and chuck before every issue.', maintenanceEveryDays: 20, photo: null, purchaseBill: null, createdAt: new Date().toISOString()
  };
  const a2 = {
    id: uid('ART'), articleType: 'Construction Tool', category: 'Cutting Tool', subcategory: 'Tile Cutting', articleName: 'Tile Cutter Machine', articleCode: 'TOOL-TILECUT-001', brand: 'Generic', modelSize: '4 inch', serialNumber: 'TC-4-001', purchaseDate: '2026-05-22', purchaseCost: 6500, qtyTotal: 2, currentLocation: 'Shop', condition: 'Good', status: 'Available', rentUnit: 'Day', rentRate: 350, depositDefault: 2000, replacementCost: 6500, vendorName: 'Power Tools Hub', warrantyTill: '', accessories: ['Blade', 'Safety guard', 'Spanner'], notes: 'Blade charge extra if broken.', maintenanceEveryDays: 15, photo: null, purchaseBill: null, createdAt: new Date().toISOString()
  };
  const a3 = {
    id: uid('ART'), articleType: 'Interior Sample / Catalogue', category: 'Laminate', subcategory: '1mm Mica', articleName: 'Greenlam Mica Catalogue', articleCode: 'CAT-MICA-001', brand: 'Greenlam', modelSize: '80 samples', serialNumber: 'GL-2026-01', purchaseDate: '2026-06-01', purchaseCost: 1500, qtyTotal: 3, currentLocation: 'Shop', condition: 'Excellent', status: 'Available', rentUnit: 'Day', rentRate: 0, depositDefault: 500, replacementCost: 1500, vendorName: 'Vinayak Mart', warrantyTill: '', accessories: ['Catalogue cover', '80 sample pieces'], notes: 'Count pages before return.', maintenanceEveryDays: 45, photo: null, purchaseBill: null, createdAt: new Date().toISOString()
  };
  const a4 = {
    id: uid('ART'), articleType: 'Interior Sample / Catalogue', category: 'PVC Panel', subcategory: 'Wall Panel Sample', articleName: 'PVC Panel Sample Book', articleCode: 'CAT-PVC-001', brand: 'Multi Brand', modelSize: '36 samples', serialNumber: 'PVC-36-01', purchaseDate: '2026-06-02', purchaseCost: 1200, qtyTotal: 2, currentLocation: 'Shop', condition: 'Good', status: 'Available', rentUnit: 'Day', rentRate: 0, depositDefault: 300, replacementCost: 1200, vendorName: 'Vinayak Mart', warrantyTill: '', accessories: ['Sample book', 'Rate card'], notes: 'Do not issue without client/site name.', maintenanceEveryDays: 45, photo: null, purchaseBill: null, createdAt: new Date().toISOString()
  };
  const articles = [a1, a2, a3, a4];
  const rental = {
    id: uid('REN'), issueNo: 'ISS-1001', articleId: a1.id, articleSnapshot: a1.articleName, quantity: 1, quantityReturned: 0,
    customerType: 'Contractor', customerName: 'Bablu Contractor', mobile: '9876543210', alternateMobile: '', address: 'Gorakhpur', siteName: 'Dr Sahi Wardrobe Work', linkedClient: 'Dr Sahi', purpose: 'Wardrobe site drilling', issueDate: todayISO(), expectedReturnDate: todayISO(), rentRate: 200, rentUnit: 'Day', deposit: 1000, advancePaid: 200, deliveryCharge: 0, paymentMode: 'Cash', issuedBy: 'Operations Manager', idProof: null, beforePhotos: [], conditionBefore: 'Good', checklist: Object.fromEntries(CHECKLISTS.toolBefore.map(x => [x, true])), accessoriesIssued: a1.accessories.map(x => ({ name: x, issued: true, returned: false })), termsAccepted: true, notes: 'Demo active rental for testing return flow.', status: 'Active', createdAt: new Date().toISOString()
  };
  const payment = { id: uid('PAY'), rentalId: rental.id, articleId: a1.id, type: 'Advance Rent', amount: 200, mode: 'Cash', date: todayISO(), receivedBy: 'Operations Manager', notes: 'Seed advance payment.' };
  const customer = { id: uid('CUS'), type: 'Contractor', name: 'Bablu Contractor', mobile: '9876543210', alternateMobile: '', gstin: '', address: 'Gorakhpur', city: 'Gorakhpur', contactPerson: 'Bablu', openingBalance: 0, notes: 'Regular contractor for small site work.', createdAt: new Date().toISOString() };
  const quotation = { id: uid('QUO'), quoteNo: 'QT-1001', status: 'Approved', customerId: customer.id, customerType: 'Contractor', customerName: customer.name, mobile: customer.mobile, siteName: 'Dr Sahi Wardrobe Work', quoteDate: todayISO(), validTill: addDaysISO(todayISO(), 7), expectedStartDate: todayISO(), deliveryCharge: 200, pickupCharge: 100, roundOff: 0, terms: 'Security deposit is refundable after return inspection. Damage, missing parts and late return are chargeable.', notes: 'Seed quotation for drill rental.', items: [{ articleId: a1.id, articleName: a1.articleName, lineType: 'Rental', qty: 1, duration: 3, rentUnit: 'Day', rate: 200, discount: 0, taxPercent: 18, deposit: 1000 }], createdAt: new Date().toISOString() };
  const invoice = { id: uid('INV'), invoiceNo: 'INV-1001', quoteId: quotation.id, rentalId: rental.id, status: 'Part Paid', customerId: customer.id, customerType: 'Contractor', customerName: customer.name, mobile: customer.mobile, siteName: 'Dr Sahi Wardrobe Work', invoiceDate: todayISO(), dueDate: addDaysISO(todayISO(), 3), deliveryCharge: 200, pickupCharge: 100, roundOff: 0, terms: 'Payment due before final deposit refund.', notes: 'Seed invoice linked with active rental.', items: quotation.items, createdAt: new Date().toISOString() };
  const expense = { id: uid('EXP'), date: todayISO(), category: 'Transport', paidTo: 'Local tempo', amount: 250, mode: 'Cash', linkedArticleId: a1.id, linkedRentalId: rental.id, notes: 'Delivery transport seed expense.', createdAt: new Date().toISOString() };
  const vendor = { id: uid('VEN'), name: 'Vinayak Mart', type: 'Material Vendor', mobile: '9876500000', gstin: '', address: 'Tool and interior market', categories: 'Mica, PVC panel, tools, spare parts', rating: 4, paymentTerms: '7 days credit', notes: 'Useful for sample books and panel catalogues.', createdAt: new Date().toISOString() };
  const purchaseOrder = { id: uid('PO'), poNo: 'PO-1001', vendorId: vendor.id, vendorName: vendor.name, date: todayISO(), expectedDate: addDaysISO(todayISO(), 2), status: 'Ordered', item: 'Replacement drill bit set', linkedArticleId: a1.id, qty: 2, rate: 350, taxPercent: 18, paidAmount: 0, notes: 'Seed spare purchase order.', createdAt: new Date().toISOString() };
  const task = { id: uid('TSK'), title: 'Call Bablu for drill return', dueDate: todayISO(), priority: 'High', assignedTo: 'Operations Manager', linkedType: 'Rental', linkedId: rental.id, customerName: rental.customerName, mobile: rental.mobile, status: 'Open', notes: 'Return is due today. Confirm tool condition before pickup.', createdAt: new Date().toISOString() };
  const movement = { id: uid('MOV'), type: 'Pickup', rentalId: rental.id, issueNo: rental.issueNo, customerName: rental.customerName, mobile: rental.mobile, articleName: rental.articleSnapshot, scheduledDate: todayISO(), scheduledTime: '18:00', fromLocation: rental.siteName, toLocation: 'Shop', vehicle: 'Local tempo', driver: 'Raju', assignedStaff: 'Field Staff', charge: 250, status: 'Scheduled', notes: 'Collect before closing.', createdAt: new Date().toISOString() };
  const audit = [makeAudit('Sample data generated', 'System', 'Owner'), makeAudit('Seed active rental created', 'Rental Issue', 'System')];
  return { articles, customers: [customer], quotations: [quotation], invoices: [invoice], expenses: [expense], vendors: [vendor], purchaseOrders: [purchaseOrder], tasks: [task], movements: [movement], staffProfiles: [{ id: 'staff-demo-ops', staffName: 'Operations Manager', userId: '', role: 'Operations Manager', mobile: '9876543210', baseSalary: 18000, monthlyAllowance: 1000, monthlyDeduction: 0, weeklyOffDay: 'Sunday', status: 'Active' }], leaveRequests: [], payrollRuns: [], salaryRules: defaultSalaryRules(), audit, rentals: [rental], returns: [], payments: [payment], repairs: [], attendance: [], settings: defaultSettings() };
}

function emptyStore(settings = defaultSettings()) {
  return {
    articles: [],
    customers: [],
    quotations: [],
    invoices: [],
    expenses: [],
    vendors: [],
    purchaseOrders: [],
    tasks: [],
    movements: [],
    staffProfiles: [],
    leaveRequests: [],
    payrollRuns: [],
    salaryRules: defaultSalaryRules(),
    audit: [makeAudit('Clean business file created', 'System', settings.roleMode || 'Owner')],
    rentals: [],
    returns: [],
    payments: [],
    repairs: [],
    attendance: [],
    settings: normalizeSettings(settings)
  };
}

function normalizeStore(parsed = {}) {
  return {
    ...emptyStore(parsed.settings),
    ...parsed,
    articles: parsed.articles || [],
    customers: parsed.customers || [],
    quotations: parsed.quotations || [],
    invoices: parsed.invoices || [],
    expenses: parsed.expenses || [],
    vendors: parsed.vendors || [],
    purchaseOrders: parsed.purchaseOrders || [],
    tasks: parsed.tasks || [],
    movements: parsed.movements || [],
    staffProfiles: parsed.staffProfiles || [],
    leaveRequests: parsed.leaveRequests || [],
    payrollRuns: parsed.payrollRuns || [],
    salaryRules: normalizeSalaryRules(parsed.salaryRules || parsed.settings?.salaryRules || {}),
    audit: parsed.audit || [],
    rentals: parsed.rentals || [],
    returns: parsed.returns || [],
    payments: parsed.payments || [],
    repairs: parsed.repairs || [],
    attendance: parsed.attendance || [],
    settings: normalizeSettings(parsed.settings)
  };
}

function safeLocalStoreSnapshot(store = {}) {
  const normalized = normalizeStore(store);
  const clean = emptyStore();
  return {
    ...clean,
    settings: normalizeSettings(normalized.settings),
    audit: (normalized.audit || []).slice(0, 50),
    localCacheNotice: 'Business records are stored in Supabase. Browser cache stores settings only unless localCacheBusinessData is enabled.',
    appVersion: APP_VERSION
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = normalizeStore(JSON.parse(raw));
    if (parsed.settings?.localCacheBusinessData === true) return parsed;
    return safeLocalStoreSnapshot(parsed);
  } catch {
    return emptyStore();
  }
}

function Badge({ children, tone = 'gray' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function StatCard({ label, value, hint, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-topline"><span>{label}</span><i /></div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Section({ title, subtitle, children, right }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, required }) {
  return (
    <label className="field">
      <span>{label}{required && <b> *</b>}</span>
      {children}
    </label>
  );
}

const MENU_GROUPS = [
  { title: 'Daily Work', items: [
    ['dashboard', 'Home'], ['attendance', 'Staff Attendance'], ['salary', 'Salary / Payroll'], ['tasks', 'Tasks / Reminders'], ['delivery', 'Delivery / Pickup'], ['issue', 'Issue Article'], ['active', 'Active Rentals'], ['return', 'Return Article']
  ]},
  { title: 'Business', items: [
    ['customers', 'Customers'], ['customer360', 'Customer 360 / Past Records'], ['quotations', 'Estimate / Quotation'], ['invoices', 'Billing / Invoice'], ['payments', 'Payments']
  ]},
  { title: 'Inventory', items: [
    ['articles', 'Article Master'], ['article360', 'Article 360 / Trace'], ['repair', 'Repair & Maintenance'], ['vendors', 'Vendors / Purchase']
  ]},
  { title: 'Accounts & Reports', items: [
    ['accounting', 'Accounting'], ['reports', 'Reports']
  ]},
  { title: 'Owner & System', items: [
    ['power', 'Owner Control'], ['settings', 'Settings'], ['backup', 'Backup']
  ]}
];

function visibleMenuGroups(settings = {}) {
  const role = settings.roleMode || 'Owner';
  const advanced = role === 'Owner' ? true : Boolean(settings.advancedMode);
  const allowed = new Set(
    role === 'Field Staff'
      ? ['dashboard', 'attendance', 'salary', 'tasks', 'delivery', 'issue', 'active', 'return', 'customers', 'customer360', 'articles', 'article360']
      : role === 'Operations Manager'
        ? ['dashboard', 'attendance', 'salary', 'tasks', 'delivery', 'issue', 'active', 'return', 'customers', 'customer360', 'quotations', 'invoices', 'payments', 'articles', 'article360', 'repair', 'vendors', 'reports']
        : MENU_GROUPS.flatMap((group) => group.items.map(([key]) => key))
  );
  const basicHidden = new Set(['accounting', 'reports', 'power', 'settings', 'backup', 'vendors']);
  return MENU_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(([key]) => allowed.has(key) && (advanced || !basicHidden.has(key))) }))
    .filter((group) => group.items.length);
}

function WorkflowSteps({ steps = [], current = 1 }) {
  return (
    <div className="workflow-steps">
      {steps.map((step, index) => (
        <div key={step} className={`workflow-step ${index + 1 <= current ? 'done' : ''} ${index + 1 === current ? 'current' : ''}`}>
          <span>{index + 1}</span>
          <b>{step}</b>
        </div>
      ))}
    </div>
  );
}

function QuickStartPanel({ setTab, stats }) {
  return (
    <section className="quick-start">
      <div>
        <h2>Daily rental desk</h2>
        <p>Fast actions for shop/site staff. Each button opens the exact working screen.</p>
      </div>
      <div className="quick-actions">
        <button onClick={() => setTab('issue')}>Issue Article</button>
        <button className="ghost" onClick={() => setTab('return')}>Return Article</button>
        <button className="ghost" onClick={() => setTab('delivery')}>Delivery / Pickup</button>
        <button className="ghost" onClick={() => setTab('tasks')}>Follow-ups ({stats.tasksDue || 0})</button>
      </div>
    </section>
  );
}

function MobileActionBar({ setTab }) {
  return (
    <div className="mobile-action-bar">
      <button onClick={() => setTab('dashboard')}>Home</button>
      <button onClick={() => setTab('issue')}>Issue</button>
      <button onClick={() => setTab('return')}>Return</button>
      <button onClick={() => setTab('tasks')}>Tasks</button>
    </div>
  );
}


function CleanStartDashboard({ setTab, loadDemo }) {
  const steps = [
    { title: '1. Add rental articles', note: 'Tools, machines, sample books, catalogues, accessories and default deposit.', tab: 'articles', action: 'Add Article' },
    { title: '2. Add customers/contractors', note: 'Client, contractor, staff or vendor party master with mobile and address.', tab: 'customers', action: 'Add Party' },
    { title: '3. Create quotation', note: 'Build estimate with rent duration, GST, deposit, transport and terms.', tab: 'quotations', action: 'Create Quote' },
    { title: '4. Issue and return articles', note: 'Before photo, checklist, accessories, due date, deposit and return inspection.', tab: 'issue', action: 'Issue Article' }
  ];
  return (
    <div className="clean-start">
      <section className="clean-hero">
        <Badge tone="green">Clean business file</Badge>
        <h2>Start with your real rental data</h2>
        <p>This version no longer opens with fake demo records. Add your own articles first, then customers, quotations, issue slips, returns, invoices and payments.</p>
        <div className="hero-actions">
          <button onClick={() => setTab('articles')}>+ Add First Article</button>
          <button className="ghost" onClick={() => setTab('customers')}>Add Customer / Contractor</button>
          <button className="ghost" onClick={loadDemo}>Load Demo Data</button>
        </div>
      </section>
      <section className="setup-grid">
        {steps.map((step) => (
          <button type="button" className="setup-card" key={step.title} onClick={() => setTab(step.tab)}>
            <b>{step.title}</b>
            <span>{step.note}</span>
            <em>{step.action} →</em>
          </button>
        ))}
      </section>
      <section className="flow-map">
        <h3>Correct daily flow</h3>
        <div className="flow-steps">
          <span>Article Master</span><i />
          <span>Quotation</span><i />
          <span>Issue Slip</span><i />
          <span>Return Check</span><i />
          <span>Invoice</span><i />
          <span>Payment / Reports</span>
        </div>
      </section>
    </div>
  );
}

function DailyFocusCards({ stats, setTab }) {
  const cards = [
    { label: 'Need return follow-up', value: stats.overdue, hint: 'Overdue articles', tone: stats.overdue ? 'red' : 'green', tab: 'active' },
    { label: 'Money to collect', value: money(stats.receivable), hint: 'Invoice receivable', tone: stats.receivable ? 'orange' : 'green', tab: 'accounting' },
    { label: 'Ready stock', value: stats.available, hint: 'Available article quantity', tone: 'blue', tab: 'articles' },
    { label: 'Today tasks', value: stats.tasksDue, hint: 'Open due reminders', tone: stats.tasksDue ? 'orange' : 'green', tab: 'tasks' }
  ];
  return (
    <div className="daily-focus-grid">
      {cards.map((card) => (
        <button type="button" key={card.label} className={`focus-card focus-${card.tone}`} onClick={() => setTab(card.tab)}>
          <span>{card.label}</span>
          <b>{card.value}</b>
          <small>{card.hint}</small>
        </button>
      ))}
    </div>
  );
}

function BusinessFlowMap({ stats, setTab }) {
  const flow = [
    { label: 'Articles', count: stats.articles, tab: 'articles' },
    { label: 'Quotations', count: stats.quoteCount || 0, tab: 'quotations' },
    { label: 'Active Rentals', count: stats.active, tab: 'active' },
    { label: 'Invoices', count: stats.invoiceCount || 0, tab: 'invoices' },
    { label: 'Payments', count: stats.paymentCount || 0, tab: 'payments' },
    { label: 'Reports', count: stats.healthScore + '%', tab: 'reports' }
  ];
  return (
    <section className="flow-map compact-flow">
      <div className="flow-head"><h3>Business flow health</h3><p>Use this instead of hunting through all modules.</p></div>
      <div className="flow-steps flow-clickable">
        {flow.map((item, index) => (
          <React.Fragment key={item.label}>
            <button type="button" onClick={() => setTab(item.tab)}><b>{item.count}</b><span>{item.label}</span></button>
            {index < flow.length - 1 && <i />}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function DashboardHero({ stats, setTab }) {
  const risks = [
    { label: 'Overdue rentals', value: stats.overdue, tone: stats.overdue ? 'red' : 'green', action: 'active' },
    { label: 'Tasks due', value: stats.tasksDue, tone: stats.tasksDue ? 'orange' : 'green', action: 'tasks' },
    { label: 'Receivable', value: money(stats.receivable), tone: stats.receivable ? 'orange' : 'green', action: 'accounting' },
    { label: 'Vendor payable', value: money(stats.purchasePayable), tone: stats.purchasePayable ? 'blue' : 'green', action: 'vendors' }
  ];
  return (
    <section className="dashboard-hero">
      <div className="hero-copy">
        <Badge tone={stats.healthScore > 75 ? 'green' : stats.healthScore > 50 ? 'orange' : 'red'}>Business Health {stats.healthScore}%</Badge>
        <h2>Rental command center</h2>
        <p>Focus first on overdue returns, due tasks, receivables and stock availability. Daily users get big actions; owner gets clear risk signals.</p>
        <div className="hero-actions">
          <button onClick={() => setTab('issue')}>+ Issue Article</button>
          <button className="ghost" onClick={() => setTab('return')}>Record Return</button>
          <button className="ghost" onClick={() => setTab('quotations')}>New Quotation</button>
          <button className="ghost" onClick={() => setTab('payments')}>Collect Payment</button>
        </div>
      </div>
      <div className="risk-stack">
        {risks.map((risk) => <button type="button" key={risk.label} className={`risk-tile risk-${risk.tone}`} onClick={() => setTab(risk.action)}><span>{risk.label}</span><b>{risk.value}</b></button>)}
      </div>
    </section>
  );
}

function PriorityStrip({ rentals, setTab, setReturnRentalId }) {
  const priority = rentals
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => (b.overdueDays - a.overdueDays) || String(a.expectedReturnDate).localeCompare(String(b.expectedReturnDate)))
    .slice(0, 3);
  return (
    <div className="priority-strip">
      <div className="priority-title"><b>Today priority</b><span>One-tap actions for the most urgent rentals.</span></div>
      <div className="priority-cards">
        {priority.map((r) => <div className="priority-card" key={r.id}>
          <div><b>{r.articleSnapshot}</b><small>{r.customerName} · Due {fmtDate(r.expectedReturnDate)}</small></div>
          <Badge tone={r.overdueDays > 0 ? 'red' : 'blue'}>{r.overdueDays > 0 ? `${r.overdueDays}d late` : 'Due'}</Badge>
          <button className="ghost" onClick={() => { setReturnRentalId(r.id); setTab('return'); }}>Return</button>
        </div>)}
        {priority.length === 0 && <Empty text="No urgent rental priority today." />}
      </div>
    </div>
  );
}

function RentalDetailPanel({ rental, store, onClose, onReturn }) {
  if (!rental) return null;
  const payments = (store.payments || []).filter((p) => p.rentalId === rental.id || p.articleId === rental.articleId);
  const returns = (store.returns || []).filter((ret) => ret.rentalId === rental.id);
  const beforeCount = (rental.beforePhotos || []).length;
  const accessoryIssued = (rental.accessoriesIssued || []).filter((x) => x.issued).map((x) => x.name).join(', ') || '-';
  const reminder = `Reminder: ${rental.articleSnapshot} issued for ${rental.siteName || 'your site'} is due on ${fmtDate(rental.expectedReturnDate)}. Please return/update status.`;
  return (
    <div className="detail-overlay">
      <div className="detail-panel">
        <div className="detail-head">
          <div>
            <h2>{rental.issueNo} · {rental.articleSnapshot}</h2>
            <p>{rental.customerName} · {rental.mobile || '-'} · {rental.siteName || '-'}</p>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <div className="detail-grid">
          <div><span>Outstanding Qty</span><b>{rental.outstanding}</b></div>
          <div><span>Due Date</span><b>{fmtDate(rental.expectedReturnDate)}</b></div>
          <div><span>Status</span><b>{rental.computedStatus}</b></div>
          <div><span>Deposit Held</span><b>{money(rental.deposit)}</b></div>
          <div><span>Rent</span><b>{money(rental.rentRate)} / {rental.rentUnit}</b></div>
          <div><span>Before Proof</span><b>{beforeCount} file(s)</b></div>
        </div>
        <div className="detail-section"><b>Purpose</b><p>{rental.purpose || '-'}</p></div>
        <div className="detail-section"><b>Accessories / Samples Issued</b><p>{accessoryIssued}</p></div>
        <div className="detail-section"><b>Payment History</b>{payments.length ? payments.slice(0, 5).map((p) => <p key={p.id}>{fmtDate(p.date)} · {p.type} · {money(p.amount)} · {p.mode}</p>) : <p>No linked payments.</p>}</div>
        <div className="detail-section"><b>Return History</b>{returns.length ? returns.map((ret) => <p key={ret.id}>{fmtDate(ret.returnDate)} · Qty {ret.quantityReturned} · {ret.conditionAfter}</p>) : <p>No return recorded yet.</p>}</div>
        <div className="row-actions sticky-actions">
          {rental.mobile && <a className="btn ghost" href={waLink(rental.mobile, reminder)} target="_blank" rel="noreferrer">WhatsApp Reminder</a>}
          {rental.outstanding > 0 && <button onClick={onReturn}>Return This Article</button>}
        </div>
      </div>
    </div>
  );
}

function Checklist({ items, value, onChange, columns = 2 }) {
  const data = value || {};
  return (
    <div className={`checklist cols-${columns}`}>
      {items.map((item) => (
        <label key={item} className="check-row">
          <input
            type="checkbox"
            checked={Boolean(data[item])}
            onChange={(e) => onChange({ ...data, [item]: e.target.checked })}
          />
          <span>{item}</span>
        </label>
      ))}
    </div>
  );
}

function FileInput({ label, onFile, accept = 'image/*,.pdf', drive }) {
  const [status, setStatus] = useState('');

  async function handleChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (drive?.enabled && drive?.upload) {
        setStatus(`Uploading to ${drive.label || 'cloud storage'}...`);
        const uploaded = await drive.upload(file, { label });
        onFile(uploaded);
        setStatus(`Saved in ${fileSourceLabel(uploaded)}: ${uploaded.name}`);
      } else {
        setStatus('Saving locally in browser...');
        onFile(await readFileAsDataUrl(file));
        setStatus('Saved locally');
      }
    } catch (error) {
      if (drive?.localFallback) {
        onFile(await readFileAsDataUrl(file));
        setStatus(`Cloud upload failed, saved locally: ${error.message}`);
      } else {
        setStatus(`Upload failed: ${error.message}`);
      }
    } finally {
      e.target.value = '';
    }
  }

  return (
    <Field label={label}>
      <input type="file" accept={accept} onChange={handleChange} />
      {status && <small className="upload-status">{status}</small>}
    </Field>
  );
}


function LoginScreen({ settings, authState, onSaveConnection, onLogin, onSignUp }) {
  const [form, setForm] = useState({
    supabaseUrl: settings.supabaseUrl || '',
    supabaseAnonKey: settings.supabaseAnonKey || '',
    email: '',
    password: '',
    fullName: '',
    mode: 'login',
    claimOwner: false
  });
  const [connectionNotice, setConnectionNotice] = useState('');
  const cleanSupabaseUrl = form.supabaseUrl.trim();
  const cleanSupabaseKey = form.supabaseAnonKey.trim();
  const urlOk = isValidSupabaseUrl(cleanSupabaseUrl);
  const keyOk = isValidSupabasePublicKey(cleanSupabaseKey);
  const configured = Boolean(urlOk && keyOk);
  const update = (key, value) => {
    setConnectionNotice('');
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function saveConnection(e) {
    e.preventDefault();
    if (!configured) {
      setConnectionNotice('Enter a valid Supabase Project URL and publishable/anon public key.');
      return;
    }
    onSaveConnection({ supabaseUrl: cleanSupabaseUrl, supabaseAnonKey: cleanSupabaseKey });
    setConnectionNotice('Supabase connection saved. Now create/login your user.');
  }

  function submitAuth(e) {
    e.preventDefault();
    if (!configured) {
      setConnectionNotice('Save a valid Supabase connection before login/signup.');
      return;
    }
    onSaveConnection({ supabaseUrl: cleanSupabaseUrl, supabaseAnonKey: cleanSupabaseKey });
    const authConnection = { supabaseUrl: cleanSupabaseUrl, supabaseAnonKey: cleanSupabaseKey };
    if (form.mode === 'signup') {
      onSignUp({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim(), claimOwner: form.claimOwner, settings: authConnection });
    } else {
      onLogin({ email: form.email.trim(), password: form.password, settings: authConnection });
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card auth-wide">
        <div className="auth-brand"><div className="logo">RS</div><div><h1>Rental Services OS</h1><p>Supabase login + database · Google Drive media</p></div></div>
        <div className="auth-grid">
          <form className="auth-panel" onSubmit={saveConnection}>
            <h2>1. Supabase Connection</h2>
            <p className="muted">Run <code>supabase-setup.sql</code>, then paste your Project URL and Supabase publishable/anon public key. Business data is saved in Supabase.</p>
            <Field label="Supabase Project URL" required><input value={form.supabaseUrl} onChange={(e) => update('supabaseUrl', e.target.value)} placeholder="https://xxxx.supabase.co" /></Field>
            <Field label="Supabase Publishable / Anon Public Key" required><input value={form.supabaseAnonKey} onChange={(e) => update('supabaseAnonKey', e.target.value)} placeholder="sb_publishable_... or eyJhbGciOi..." /></Field>
            {connectionNotice && <div className={configured ? "alert alert-green" : "alert alert-red"}>{connectionNotice}</div>}
            <button type="submit" className="primary" disabled={!configured}>Save Supabase Connection</button>
          </form>
          <form className="auth-panel" onSubmit={submitAuth}>
            <h2>2. Role Based Login</h2>
            <div className="segmented">
              <button type="button" className={form.mode === 'login' ? 'active' : ''} onClick={() => update('mode', 'login')}>Login</button>
              <button type="button" className={form.mode === 'signup' ? 'active' : ''} onClick={() => update('mode', 'signup')}>Create User</button>
            </div>
            {form.mode === 'signup' && <Field label="Full Name"><input value={form.fullName} onChange={(e) => update('fullName', e.target.value)} placeholder="Staff / owner name" /></Field>}
            <Field label="Email" required><input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="user@example.com" /></Field>
            <Field label="Password" required><input type="password" value={form.password} onChange={(e) => update('password', e.target.value)} placeholder="Minimum 6 characters" /></Field>
            {form.mode === 'signup' && <label className="terms"><input type="checkbox" checked={form.claimOwner} onChange={(e) => update('claimOwner', e.target.checked)} /> <span>Claim Owner role if this is the first owner account</span></label>}
            {authState.error && <div className="alert alert-red">{authState.error}</div>}
            {authState.notice && <div className="alert alert-green">{authState.notice}</div>}
            <button type="submit" disabled={!configured || authState.loading}>{form.mode === 'signup' ? 'Create Account' : 'Login'}</button>
          </form>
        </div>
        <div className="auth-notes">
          <div><b>Role rules</b><p>Owner gets full access. Operations Manager gets daily work, customers, quotation, invoice, reports. Field Staff gets daily work only.</p></div>
          <div><b>Media rule</b><p>Photos, bills, ID proof, before/after proofs and catalogues upload to Google Drive only. Supabase stores records and Drive links.</p></div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [store, setStore] = useState(loadStore);
  const [tab, setTab] = useState('dashboard');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedArticleId, setSelectedArticleId] = useState('');
  const [editingArticle, setEditingArticle] = useState(null);
  const [returnRentalId, setReturnRentalId] = useState('');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [driveState, setDriveState] = useState({ accessToken: '', connected: false, status: 'Not connected', uploading: false });
  const [supabaseState, setSupabaseState] = useState({ client: null, connected: false, status: 'Not connected', syncing: false, uploading: false });
  const [authState, setAuthState] = useState({ loading: true, session: null, user: null, profile: null, error: '', notice: '' });

  useEffect(() => {
    const cachePayload = store.settings?.localCacheBusinessData === true ? store : safeLocalStoreSnapshot(store);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachePayload));
  }, [store]);

  useEffect(() => {
    const onError = (event) => notify(event?.message || 'Unexpected app error');
    const onRejection = (event) => notify(event?.reason?.message || 'Unexpected sync/action error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);


  useEffect(() => {
    const settings = normalizeSettings(store.settings);
    if (!settings.supabaseEnabled || !settings.supabaseUrl || !settings.supabaseAnonKey) {
      setAuthState((a) => ({ ...a, loading: false }));
      return;
    }
    let mounted = true;
    let subscription;
    const client = getSupabaseClient(settings);
    setSupabaseState((d) => ({ ...d, client, connected: false, status: 'Supabase auth ready' }));
    client.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data?.session) {
        completeAuthSession(client, data.session, { settingsOverride: settings }).catch((error) => setAuthState((a) => ({ ...a, loading: false, error: error.message || 'Session load failed' })));
      } else {
        setAuthState((a) => ({ ...a, loading: false, session: null, user: null, profile: null }));
      }
    }).catch((error) => mounted && setAuthState((a) => ({ ...a, loading: false, error: error.message || 'Supabase auth failed' })));
    const authListener = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (!session) {
        setAuthState((a) => ({ ...a, loading: false, session: null, user: null, profile: null }));
        return;
      }
      completeAuthSession(client, session, { settingsOverride: settings }).catch((error) => setAuthState((a) => ({ ...a, loading: false, error: error.message || 'Auth state failed' })));
    });
    subscription = authListener?.data?.subscription;
    return () => { mounted = false; subscription?.unsubscribe?.(); };
  }, [store.settings.supabaseUrl, store.settings.supabaseAnonKey, store.settings.supabaseEnabled]);

  function saveStore(next) {
    setStore((prev) => (typeof next === 'function' ? next(prev) : next));
  }


  function saveStoreWithAudit(next, action, area = 'System') {
    setStore((prev) => {
      const base = typeof next === 'function' ? next(prev) : next;
      return { ...base, audit: [makeAudit(action, area, base.settings?.roleMode || 'Owner'), ...(base.audit || [])].slice(0, 500) };
    });
  }

  function notify(message) {
    setToast(message);
    setTimeout(() => setToast(''), 2800);
  }


  async function completeAuthSession(client, session, options = {}) {
    if (!session?.user) {
      setAuthState((a) => ({ ...a, loading: false, session: null, user: null, profile: null }));
      return null;
    }
    await client.rpc('claim_first_owner', { p_full_name: session.user.user_metadata?.full_name || session.user.email || 'Owner' }).catch(() => null);
    const profile = await fetchAppUserProfile(client, session.user);
    setSupabaseState((d) => ({ ...d, client, connected: true, status: `Logged in as ${profile.role}`, syncing: false }));
    setAuthState({ loading: false, session, user: session.user, profile, error: '', notice: '' });
    setStore((prev) => applyRoleToStoreSettings(prev, profile));
    const settings = normalizeSettings({ ...store.settings, ...(options.settingsOverride || {}) });
    if (settings.supabaseAutoSyncData && !options.skipLoad) {
      try {
        const remote = await loadStoreFromSupabase({ client, settings });
        const merged = applyRoleToStoreSettings(normalizeImportedStore(remote.payload, settings), profile);
        setStore(merged);
        setSupabaseState((d) => ({ ...d, client, connected: true, status: `Loaded Supabase data · ${profile.role}` }));
      } catch (error) {
        setSupabaseState((d) => ({ ...d, client, connected: true, status: error.message?.includes('No Supabase') ? `Logged in · no Supabase data yet` : (error.message || 'Logged in') }));
      }
    }
    return profile;
  }

  async function handleLogin({ email, password, settings: authSettings = {} }) {
    try {
      if (!email || !password) throw new Error('Enter email and password');
      setAuthState((a) => ({ ...a, loading: true, error: '', notice: '' }));
      const loginSettings = normalizeSettings({ ...store.settings, ...authSettings, supabaseEnabled: true });
      const client = getSupabaseClient(loginSettings);
      saveConnectionSettings(authSettings);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await completeAuthSession(client, data.session, { settingsOverride: loginSettings });
      notify('Logged in with Supabase');
    } catch (error) {
      setAuthState((a) => ({ ...a, loading: false, error: error.message || 'Login failed' }));
    }
  }

  async function handleSignUp({ email, password, fullName, claimOwner, settings: authSettings = {} }) {
    try {
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address');
      if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
      setAuthState((a) => ({ ...a, loading: true, error: '', notice: '' }));
      const signupSettings = normalizeSettings({ ...store.settings, ...authSettings, supabaseEnabled: true });
      const client = getSupabaseClient(signupSettings);
      saveConnectionSettings(authSettings);
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          emailRedirectTo: getAuthRedirectUrl()
        }
      });
      if (error) throw error;
      if (data.session) {
        if (claimOwner) await client.rpc('claim_first_owner', { p_full_name: fullName || email }).catch(() => null);
        await completeAuthSession(client, data.session, { skipLoad: true, settingsOverride: signupSettings });
        notify(claimOwner ? 'Owner account created' : 'Staff account created');
      } else {
        setAuthState((a) => ({ ...a, loading: false, notice: 'Account created. Check email confirmation, then log in.' }));
      }
    } catch (error) {
      setAuthState((a) => ({ ...a, loading: false, error: error.message || 'Signup failed' }));
    }
  }

  async function handleLogout() {
    try {
      const client = supabaseState.client || getSupabaseClient(store.settings);
      await client.auth.signOut();
    } catch {}
    setAuthState({ loading: false, session: null, user: null, profile: null, error: '', notice: '' });
    setSupabaseState((d) => ({ ...d, connected: false, status: 'Logged out' }));
    notify('Logged out');
  }

  function saveConnectionSettings(settingsPatch) {
    saveStore((prev) => ({ ...prev, settings: normalizeSettings({ ...prev.settings, ...settingsPatch, supabaseEnabled: true, supabaseAutoSyncData: true, mediaStorage: 'googleDrive' }) }));
  }

  async function handleDriveConnect(clientIdOverride) {
    try {
      const clientId = clientIdOverride || store.settings.driveClientId;
      setDriveState((d) => ({ ...d, status: 'Connecting to Google Drive...' }));
      const accessToken = await connectGoogleDrive(clientId);
      setDriveState({ accessToken, connected: true, status: 'Connected', uploading: false });
      notify('Google Drive connected');
    } catch (error) {
      setDriveState((d) => ({ ...d, connected: false, status: error.message || 'Connection failed' }));
      notify(error.message || 'Google Drive connection failed');
    }
  }

  async function uploadFileThroughDrive(file, context = {}) {
    if (!driveState.accessToken) throw new Error('Connect Google Drive first');
    const settings = normalizeSettings(store.settings);
    const safeLabel = String(context.label || 'File').replace(/[^a-z0-9 _.-]/gi, '').trim() || 'File';
    const fileName = `${todayISO()}-${safeLabel}-${file.name}`.replace(/\s+/g, '-');
    setDriveState((d) => ({ ...d, uploading: true, status: `Uploading ${file.name}...` }));
    try {
      const uploaded = await uploadBlobToDrive({
        accessToken: driveState.accessToken,
        blob: file,
        fileName,
        mimeType: file.type,
        folderName: settings.driveFolderName,
        subFolderName: safeLabel
      });
      const enrichedUpload = {
        ...uploaded,
        recordType: context.recordType || context.label || 'Media',
        recordId: context.recordId || context.ownerId || '',
        uploadedBy: authState.profile?.id || '',
        uploadedByRole: authState.profile?.role || ''
      };
      if (supabaseState.client) {
        persistMediaMetadata({ client: supabaseState.client, file: enrichedUpload, context, authProfile: authState.profile })
          .catch((err) => console.warn('Media metadata save failed', err.message || err));
      }
      setDriveState((d) => ({ ...d, uploading: false, status: `Uploaded ${uploaded.name}` }));
      return enrichedUpload;
    } catch (error) {
      setDriveState((d) => ({ ...d, uploading: false, status: error.message || 'Upload failed' }));
      throw error;
    }
  }

  async function handleSupabaseConnect(settingsOverride) {
    const settings = normalizeSettings(settingsOverride || store.settings);
    try {
      setSupabaseState((d) => ({ ...d, status: 'Connecting to Supabase...' }));
      const client = getSupabaseClient(settings);
      await testSupabaseConnection({ client, settings });
      setSupabaseState({ client, connected: true, status: 'Connected', syncing: false, uploading: false });
      notify('Supabase connected');
      return client;
    } catch (error) {
      setSupabaseState((d) => ({ ...d, client: null, connected: false, status: error.message || 'Supabase connection failed', syncing: false, uploading: false }));
      notify(error.message || 'Supabase connection failed');
      throw error;
    }
  }

  async function syncToSupabase(clientOverride) {
    const settings = normalizeSettings(store.settings);
    const client = clientOverride || supabaseState.client || getSupabaseClient(settings);
    setSupabaseState((d) => ({ ...d, syncing: true, status: 'Saving app data to Supabase...' }));
    try {
      const result = await saveStoreToSupabase({ client, store, settings, authProfile: authState.profile });
      setSupabaseState((d) => ({ ...d, client, connected: true, syncing: false, status: `Synced to Supabase at ${new Date(result.updatedAt).toLocaleTimeString('en-IN')}` }));
      notify('Data saved to Supabase');
      return result;
    } catch (error) {
      setSupabaseState((d) => ({ ...d, syncing: false, status: error.message || 'Supabase sync failed' }));
      notify(error.message || 'Supabase sync failed');
      throw error;
    }
  }

  async function loadFromSupabase() {
    const settings = normalizeSettings(store.settings);
    const client = supabaseState.client || getSupabaseClient(settings);
    setSupabaseState((d) => ({ ...d, syncing: true, status: 'Loading app data from Supabase...' }));
    try {
      const remote = await loadStoreFromSupabase({ client, settings });
      const merged = normalizeImportedStore(remote.payload, store.settings);
      setStore(merged);
      setSupabaseState((d) => ({ ...d, client, connected: true, syncing: false, status: `Loaded Supabase snapshot from ${new Date(remote.updated_at).toLocaleString('en-IN')}` }));
      notify('Data loaded from Supabase');
    } catch (error) {
      setSupabaseState((d) => ({ ...d, syncing: false, status: error.message || 'Supabase load failed' }));
      notify(error.message || 'Supabase load failed');
    }
  }

  async function uploadFileThroughCloud(file, context = {}) {
    const settings = normalizeSettings(store.settings);
    const driveReady = settings.driveEnabled && settings.driveAutoUploadFiles && driveState.connected;
    if (driveReady) return uploadFileThroughDrive(file, context);
    throw new Error('Google Drive media storage is not connected');
  }

  useEffect(() => {
    const settings = normalizeSettings(store.settings);
    if (!settings.supabaseEnabled || !settings.supabaseAutoSyncData || !supabaseState.connected || !supabaseState.client) return;
    const timer = setTimeout(() => {
      saveStoreToSupabase({ client: supabaseState.client, store, settings, authProfile: authState.profile })
        .then((result) => setSupabaseState((d) => ({ ...d, syncing: false, status: `Auto-synced at ${new Date(result.updatedAt).toLocaleTimeString('en-IN')}` })))
        .catch((error) => setSupabaseState((d) => ({ ...d, syncing: false, status: error.message || 'Auto-sync failed' })));
    }, 1500);
    return () => clearTimeout(timer);
  }, [store, supabaseState.connected, supabaseState.client]);

  const cloudUpload = {
    enabled: Boolean(store.settings.driveEnabled && store.settings.driveAutoUploadFiles && driveState.connected),
    localFallback: Boolean(store.settings.driveLocalFallback),
    upload: uploadFileThroughCloud,
    label: 'Google Drive',
    state: { drive: driveState }
  };

  const articleMap = useMemo(() => Object.fromEntries(store.articles.map((a) => [a.id, a])), [store.articles]);

  function outstandingQty(rental) {
    return Math.max(0, toNumber(rental.quantity) - toNumber(rental.quantityReturned));
  }

  function activeRentals() {
    return store.rentals.filter((r) => outstandingQty(r) > 0 && !['Closed', 'Cancelled'].includes(r.status));
  }

  function articleAvailableQty(articleId) {
    const article = articleMap[articleId];
    if (!article) return 0;
    const outside = activeRentals().filter((r) => r.articleId === articleId).reduce((sum, r) => sum + outstandingQty(r), 0);
    const blocked = ['In Repair', 'Damaged', 'Lost', 'Retired'].includes(article.status) ? toNumber(article.qtyTotal) : 0;
    return Math.max(0, toNumber(article.qtyTotal) - outside - blocked);
  }

  const enrichedRentals = useMemo(() => {
    return store.rentals.map((r) => {
      const article = articleMap[r.articleId];
      const od = outstandingQty(r);
      const late = od > 0 ? overdueDays(r.expectedReturnDate) : 0;
      return { ...r, article, outstanding: od, overdueDays: late, computedStatus: od <= 0 ? 'Returned' : late > 0 ? 'Overdue' : r.status || 'Active' };
    });
  }, [store.rentals, articleMap]);

  const stats = useMemo(() => {
    const active = enrichedRentals.filter((r) => r.outstanding > 0);
    const overdue = active.filter((r) => r.overdueDays > 0);
    const depositHeld = active.reduce((s, r) => s + toNumber(r.deposit), 0);
    const repairCost = store.repairs.reduce((s, r) => s + toNumber(r.repairCost), 0);
    const expenseTotal = (store.expenses || []).reduce((s, e) => s + toNumber(e.amount), 0);
    const collected = store.payments.filter((p) => p.type !== 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
    const refunded = store.payments.filter((p) => p.type === 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
    const invoiceTotal = (store.invoices || []).reduce((s, inv) => s + computeDocTotals(inv.items || [], inv).grandTotal, 0);
    const receivable = (store.invoices || []).reduce((s, inv) => s + invoiceBalance(inv, store.payments || []), 0);
    const quoteValue = (store.quotations || []).reduce((s, q) => s + computeDocTotals(q.items || [], q).grandTotal, 0);
    return {
      articles: store.articles.length,
      active: active.length,
      overdue: overdue.length,
      depositHeld,
      repairCost,
      collected,
      refunded,
      expenseTotal,
      invoiceTotal,
      receivable,
      quoteValue,
      quoteCount: (store.quotations || []).length,
      invoiceCount: (store.invoices || []).length,
      paymentCount: (store.payments || []).length,
      customerCount: (store.customers || []).length,
      tasksDue: (store.tasks || []).filter((t) => t.status !== 'Done' && t.dueDate && new Date(t.dueDate + 'T00:00:00') <= new Date(todayISO() + 'T00:00:00')).length,
      pendingMovements: (store.movements || []).filter((m) => !['Completed', 'Cancelled'].includes(m.status)).length,
      purchasePayable: (store.purchaseOrders || []).reduce((s, po) => s + Math.max(0, (toNumber(po.qty) * toNumber(po.rate) + percentAmount(toNumber(po.qty) * toNumber(po.rate), po.taxPercent)) - toNumber(po.paidAmount)), 0),
      healthScore: businessHealthScore(store),
      available: store.articles.reduce((s, a) => s + articleAvailableQty(a.id), 0)
    };
  }, [enrichedRentals, store, articleAvailableQty]);

  const menuGroups = useMemo(() => visibleMenuGroups(store.settings), [store.settings]);
  const visibleTabs = useMemo(() => new Set(menuGroups.flatMap((group) => group.items.map(([key]) => key))), [menuGroups]);

  useEffect(() => {
    if (!visibleTabs.has(tab)) setTab('dashboard');
  }, [tab, visibleTabs]);

  const hasAnyData = ['articles', 'customers', 'quotations', 'invoices', 'expenses', 'vendors', 'purchaseOrders', 'tasks', 'movements', 'staffProfiles', 'leaveRequests', 'payrollRuns', 'rentals', 'returns', 'payments', 'repairs', 'attendance'].some((key) => (store[key] || []).length > 0);
  const isOwner = (authState.profile?.role || store.settings.roleMode || 'Field Staff') === 'Owner';
  const currentUserLabel = authState.profile ? `${authState.profile.full_name || authState.profile.email} · ${authState.profile.role}` : 'Not logged in';
  const resetCleanStore = () => setStore(emptyStore(store.settings));
  const loadDemoStore = () => { setStore(seedStore()); notify('Demo data loaded. Use Clear Data to return to a blank business file.'); };

  if (authState.loading) {
    return <div className="auth-shell"><div className="auth-card"><h1>Rental Services OS</h1><p>Checking Supabase login...</p></div></div>;
  }

  if (!authState.session || !authState.profile) {
    return <LoginScreen settings={store.settings} authState={authState} onSaveConnection={saveConnectionSettings} onLogin={handleLogin} onSignUp={handleSignUp} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">RS</div>
          <div>
            <h1>Rental Services OS</h1>
            <p>Tools + Interior Samples</p>
          </div>
        </div>
        <nav>
          {menuGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-title">{group.title}</div>
              {group.items.map(([key, label]) => (
                <button key={key} aria-label={`Open ${label}`} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>{store.settings.firmName || 'Rental Services OS'}</h1>
            <p>Customer → Quotation → Approval → Issue → Delivery/Pickup → Invoice → Payment → Accounting</p>
          </div>
          <div className="top-actions">
            <span className="role-pill">{currentUserLabel}</span>
            <button className="ghost" onClick={handleLogout}>Logout</button>
            {isOwner && <details className="data-tools"><summary>Owner Data Tools</summary><div><button className="ghost" onClick={loadDemoStore}>Load demo</button><button className="danger ghost" onClick={() => { if (confirm('Clear all app data from this browser?')) { resetCleanStore(); notify('Clean blank business file created'); } }}>Clear data</button></div></details>}
          </div>
        </header>

        {toast && <div className="toast">{toast}</div>}

        {tab === 'dashboard' && <Dashboard stats={stats} rentals={enrichedRentals} articles={store.articles} articleAvailableQty={articleAvailableQty} setTab={setTab} setReturnRentalId={setReturnRentalId} loadDemo={loadDemoStore} hasAnyData={hasAnyData} />}
        {tab === 'power' && <OwnerControlCenter store={store} saveStore={saveStoreWithAudit} notify={notify} stats={stats} rentals={enrichedRentals} />}
        {tab === 'attendance' && <AttendanceModule store={store} saveStore={saveStoreWithAudit} notify={notify} currentUser={authState.profile} isOwner={isOwner} />}
        {tab === 'salary' && <SalaryPayrollModule store={store} saveStore={saveStoreWithAudit} notify={notify} currentUser={authState.profile} isOwner={isOwner} />}
        {tab === 'tasks' && <TaskReminderCenter store={store} saveStore={saveStoreWithAudit} notify={notify} isOwner={isOwner} currentUser={authState.profile} drive={cloudUpload} />}
        {tab === 'delivery' && <DeliveryPickupCenter store={store} saveStore={saveStoreWithAudit} notify={notify} />}
        {tab === 'vendors' && <VendorPurchaseCenter store={store} saveStore={saveStoreWithAudit} notify={notify} />}
        {tab === 'customers' && <CustomerMaster store={store} saveStore={saveStore} notify={notify} onOpen360={(id) => { setSelectedCustomerId(id); setTab('customer360'); }} />}
        {tab === 'customer360' && <Customer360 store={store} selectedCustomerId={selectedCustomerId} setSelectedCustomerId={setSelectedCustomerId} setTab={setTab} />}
        {tab === 'articles' && <ArticleMaster store={store} saveStore={saveStore} notify={notify} editingArticle={editingArticle} setEditingArticle={setEditingArticle} query={query} setQuery={setQuery} articleAvailableQty={articleAvailableQty} drive={cloudUpload} onOpenTrace={(id) => { setSelectedArticleId(id); setTab('article360'); }} />}
        {tab === 'article360' && <Article360 store={store} selectedArticleId={selectedArticleId} setSelectedArticleId={setSelectedArticleId} setTab={setTab} setReturnRentalId={setReturnRentalId} setEditingArticle={setEditingArticle} />}
        {tab === 'quotations' && <QuotationBuilder store={store} saveStore={saveStore} notify={notify} articleAvailableQty={articleAvailableQty} setTab={setTab} />}
        {tab === 'issue' && <IssueArticle store={store} saveStore={saveStore} notify={notify} articleAvailableQty={articleAvailableQty} drive={cloudUpload} />}
        {tab === 'active' && <ActiveRentals rentals={enrichedRentals} store={store} setTab={setTab} setReturnRentalId={setReturnRentalId} />}
        {tab === 'return' && <ReturnArticle store={store} saveStore={saveStore} notify={notify} enrichedRentals={enrichedRentals} returnRentalId={returnRentalId} setReturnRentalId={setReturnRentalId} drive={cloudUpload} />}
        {tab === 'repair' && <RepairMaintenance store={store} saveStore={saveStore} notify={notify} drive={cloudUpload} />}
        {tab === 'payments' && <Payments store={store} saveStore={saveStore} notify={notify} />}
        {tab === 'invoices' && <InvoiceBilling store={store} saveStore={saveStore} notify={notify} />}
        {tab === 'accounting' && <AccountingPanel store={store} saveStore={saveStore} notify={notify} />}
        {tab === 'reports' && <Reports store={store} rentals={enrichedRentals} articleAvailableQty={articleAvailableQty} />}
        {tab === 'settings' && <SettingsPanel store={store} saveStore={saveStore} notify={notify} driveState={driveState} connectDrive={handleDriveConnect} uploadToDrive={uploadFileThroughDrive} supabaseState={supabaseState} connectSupabase={handleSupabaseConnect} syncToSupabase={syncToSupabase} loadFromSupabase={loadFromSupabase} />}
        {tab === 'backup' && <Backup store={store} saveStore={saveStore} notify={notify} uploadToDrive={uploadFileThroughDrive} driveState={driveState} supabaseState={supabaseState} syncToSupabase={syncToSupabase} loadFromSupabase={loadFromSupabase} />}
        <MobileActionBar setTab={setTab} />
      </main>
    </div>
  );
}

function Dashboard({ stats, rentals, articles, articleAvailableQty, setTab, setReturnRentalId, loadDemo, hasAnyData }) {
  const overdue = rentals.filter((r) => r.outstanding > 0 && r.overdueDays > 0);
  const dueToday = rentals.filter((r) => r.outstanding > 0 && r.expectedReturnDate === todayISO());
  const repairArticles = articles.filter((a) => ['In Repair', 'Damaged'].includes(a.status));

  if (!hasAnyData) {
    return <CleanStartDashboard setTab={setTab} loadDemo={loadDemo} />;
  }

  return (
    <>
      <DashboardHero stats={stats} setTab={setTab} />
      <DailyFocusCards stats={stats} setTab={setTab} />
      <QuickStartPanel setTab={setTab} stats={stats} />
      <PriorityStrip rentals={rentals} setTab={setTab} setReturnRentalId={setReturnRentalId} />
      <BusinessFlowMap stats={stats} setTab={setTab} />
      <details className="owner-metrics">
        <summary>Show owner metrics and accounting KPIs</summary>
        <div className="stats-grid stats-grid-premium">
          <StatCard label="Total Articles" value={stats.articles} hint="Tools + catalogues" />
          <StatCard label="Available Qty" value={stats.available} hint="Ready for issue" tone="green" />
          <StatCard label="Active Rentals" value={stats.active} hint="Currently outside" tone="blue" />
          <StatCard label="Overdue" value={stats.overdue} hint="Need follow-up" tone="red" />
          <StatCard label="Deposit Held" value={money(stats.depositHeld)} hint="Refundable liability" />
          <StatCard label="Collected" value={money(stats.collected)} hint="Rent/advance/damage" tone="green" />
          <StatCard label="Receivable" value={money(stats.receivable)} hint="Unpaid invoices" tone="orange" />
          <StatCard label="Quotation Value" value={money(stats.quoteValue)} hint="Estimate pipeline" tone="blue" />
          <StatCard label="Tasks Due" value={stats.tasksDue} hint="Follow-up reminders" tone="orange" />
          <StatCard label="Delivery/Pickup" value={stats.pendingMovements} hint="Pending movements" tone="blue" />
          <StatCard label="Purchase Payable" value={money(stats.purchasePayable)} hint="Vendor balance" tone="orange" />
          <StatCard label="Health Score" value={`${stats.healthScore}%`} hint="Data/accountability quality" tone={stats.healthScore > 75 ? 'green' : stats.healthScore > 50 ? 'orange' : 'red'} />
          <StatCard label="Expenses" value={money(stats.expenseTotal)} hint="Transport/repair/staff etc." />
          <StatCard label="Refunded" value={money(stats.refunded)} hint="Deposit returned" />
          <StatCard label="Repair Cost" value={money(stats.repairCost)} hint="Maintenance expense" tone="orange" />
        </div>
      </details>

      <div className="two-col">
        <Section title="Due / Overdue Follow-up" subtitle="Daily check: articles due today and late returns.">
          <div className="cards-list">
            {[...overdue, ...dueToday.filter((r) => !overdue.some((o) => o.id === r.id))].slice(0, 6).map((r) => (
              <RentalCard key={r.id} rental={r} onReturn={() => { setReturnRentalId(r.id); setTab('return'); }} />
            ))}
            {overdue.length === 0 && dueToday.length === 0 && <Empty text="No due or overdue rentals today." />}
          </div>
        </Section>

        <Section title="Stock Health" subtitle="Do not issue articles marked repair/damaged/lost.">
          <div className="mini-table">
            <div className="mini-row head"><span>Article</span><span>Available</span><span>Status</span></div>
            {articles.slice(0, 8).map((a) => (
              <div className="mini-row" key={a.id}>
                <span>{a.articleName}<small>{a.articleCode}</small></span>
                <b>{articleAvailableQty(a.id)} / {a.qtyTotal}</b>
                <Badge tone={a.status === 'Available' ? 'green' : ['In Repair', 'Damaged', 'Lost'].includes(a.status) ? 'red' : 'gray'}>{a.status}</Badge>
              </div>
            ))}
            {articles.length === 0 && <Empty text="Add your first rental article." />}
          </div>
          {repairArticles.length > 0 && <p className="warn-line">{repairArticles.length} article(s) need repair/damage attention.</p>}
        </Section>
      </div>
    </>
  );
}


function OwnerControlCenter({ store, saveStore, notify, stats, rentals }) {
  const [settings, setSettings] = useState({
    roleMode: store.settings.roleMode || 'Owner',
    advancedMode: Boolean(store.settings.advancedMode),
    approvalRequiredAbove: store.settings.approvalRequiredAbove || 5000,
    latePenaltyPerDay: store.settings.latePenaltyPerDay || 100,
    lowStockWarningQty: store.settings.lowStockWarningQty || 1
  });
  const issues = buildDataQuality(store);
  const highIssues = issues.filter((i) => i.severity === 'High');
  const overdueRentals = rentals.filter((r) => r.outstanding > 0 && r.overdueDays > 0);
  const auditRows = [...(store.audit || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  function saveSettings(e) {
    e.preventDefault();
    saveStore((prev) => ({ ...prev, settings: normalizeSettings({ ...prev.settings, ...settings }) }), 'Owner control settings updated', 'Owner Control');
    notify('Owner control settings saved');
  }

  function createOverdueTasks() {
    const existingKeys = new Set((store.tasks || []).map((t) => `${t.linkedType}-${t.linkedId}-${t.title}`));
    const tasks = overdueRentals
      .filter((r) => !existingKeys.has(`Rental-${r.id}-Follow up overdue return`))
      .map((r) => ({
        id: uid('TSK'), title: 'Follow up overdue return', frequency: 'One-time', dueDate: todayISO(), autoCarryToDaily: true, priority: 'High', assignedTo: 'Operations Manager', linkedType: 'Rental', linkedId: r.id,
        customerName: r.customerName, mobile: r.mobile, status: 'Open', notes: `${r.articleSnapshot} is overdue by ${r.overdueDays} day(s). Expected return: ${fmtDate(r.expectedReturnDate)}.`, createdAt: new Date().toISOString()
      }));
    if (!tasks.length) return notify('No new overdue tasks needed');
    saveStore((prev) => ({ ...prev, tasks: [...tasks, ...(prev.tasks || [])] }), `${tasks.length} overdue return task(s) created`, 'Tasks');
    notify(`${tasks.length} task(s) created`);
  }

  function exportMasterCsv() {
    exportCsv(`rental-master-export-${todayISO()}.csv`, (store.articles || []).map((a) => ({ Code: a.articleCode, Article: a.articleName, Type: a.articleType, Category: a.category, Qty: a.qtyTotal, Status: a.status, Rent: a.rentRate, Deposit: a.depositDefault, Replacement: a.replacementCost })));
  }
  function exportReceivableCsv() {
    const rows = (store.invoices || []).map((inv) => ({ Invoice: inv.invoiceNo, Party: inv.customerName, Date: inv.invoiceDate, DueDate: inv.dueDate, Total: computeDocTotals(inv.items || [], inv).grandTotal, Paid: invoicePaidAmount(inv.id, store.payments || []), Balance: invoiceBalance(inv, store.payments || []), Status: inv.status }));
    exportCsv(`receivables-${todayISO()}.csv`, rows);
  }

  return (
    <>
      <div className="stats-grid">
        <StatCard label="Business Health" value={`${stats.healthScore}%`} hint="Data + accountability score" tone={stats.healthScore > 75 ? 'green' : stats.healthScore > 50 ? 'orange' : 'red'} />
        <StatCard label="High Risk Issues" value={highIssues.length} hint="Fix before real operations" tone={highIssues.length ? 'red' : 'green'} />
        <StatCard label="Open Tasks" value={(store.tasks || []).filter((t) => t.status !== 'Done').length} hint="Staff follow-ups" tone="orange" />
        <StatCard label="Audit Events" value={(store.audit || []).length} hint="Owner visibility" tone="blue" />
      </div>

      <Section title="Owner Mode & Safety Controls" subtitle="Basic/Advanced access, penalty policy and approval limits.">
        <form className="form-grid" onSubmit={saveSettings}>
          <Field label="Role Mode"><select value={settings.roleMode} onChange={(e) => setSettings((f) => ({ ...f, roleMode: e.target.value }))}><option>Owner</option><option>Operations Manager</option><option>Field Staff</option></select></Field>
          <Field label="View Mode"><select value={settings.advancedMode ? 'Advanced' : 'Basic'} onChange={(e) => setSettings((f) => ({ ...f, advancedMode: e.target.value === 'Advanced' }))}><option>Advanced</option><option>Basic</option></select></Field>
          <Field label="Approval Required Above ₹"><input type="number" value={settings.approvalRequiredAbove} onChange={(e) => setSettings((f) => ({ ...f, approvalRequiredAbove: toNumber(e.target.value) }))} /></Field>
          <Field label="Late Penalty / Day"><input type="number" value={settings.latePenaltyPerDay} onChange={(e) => setSettings((f) => ({ ...f, latePenaltyPerDay: toNumber(e.target.value) }))} /></Field>
          <Field label="Low Stock Warning Qty"><input type="number" value={settings.lowStockWarningQty} onChange={(e) => setSettings((f) => ({ ...f, lowStockWarningQty: toNumber(e.target.value) }))} /></Field>
          <div className="form-actions wide"><button type="submit">Save Owner Controls</button><button type="button" className="ghost" onClick={createOverdueTasks}>Create Tasks for Overdue Rentals</button><button type="button" className="ghost" onClick={exportMasterCsv}>Export Article CSV</button><button type="button" className="ghost" onClick={exportReceivableCsv}>Export Receivable CSV</button></div>
        </form>
      </Section>

      <Section title="Data Quality & Risk Center" subtitle="Shows missing proof, missing return dates, overdue receivables and weak master records.">
        <div className="table-wrap"><table><thead><tr><th>Severity</th><th>Area</th><th>Issue</th><th>Recommended Action</th></tr></thead><tbody>{issues.map((i, idx) => <tr key={idx}><td><Badge tone={i.severity === 'High' ? 'red' : i.severity === 'Medium' ? 'orange' : 'blue'}>{i.severity}</Badge></td><td>{i.area}</td><td>{i.issue}</td><td>{i.action}</td></tr>)}</tbody></table>{issues.length === 0 && <Empty text="No major data quality issues found." />}</div>
      </Section>

      <Section title="Owner Audit Trail" subtitle="Non-deletable style activity list for important actions in this frontend app.">
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Area</th><th>User</th><th>Action</th></tr></thead><tbody>{auditRows.slice(0, 80).map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('en-IN')}</td><td>{row.area}</td><td>{row.user}</td><td>{row.action}</td></tr>)}</tbody></table>{auditRows.length === 0 && <Empty text="No audit events yet." />}</div>
      </Section>
    </>
  );
}

function TaskReminderCenter({ store, saveStore, notify, isOwner = false, currentUser = null, drive = null }) {
  const freshTaskForm = () => ({
    title: '',
    frequency: 'One-time',
    dueDate: todayISO(),
    autoCarryToDaily: true,
    priority: 'Medium',
    assignedTo: currentUser?.role || 'Operations Manager',
    linkedType: 'Rental',
    linkedId: '',
    customerName: '',
    mobile: '',
    status: 'Open',
    notes: '',
    proofRequired: true
  });
  const [form, setForm] = useState(freshTaskForm());
  const [filter, setFilter] = useState('Daily');
  const [proofDrafts, setProofDrafts] = useState({});
  const [proofUploadStatus, setProofUploadStatus] = useState({});
  const normalizedTasks = useMemo(() => (store.tasks || []).map(normalizeTask), [store.tasks]);
  const sortedTasks = useMemo(() => [...normalizedTasks].sort((a, b) => {
    const doneSort = Number(a.status === 'Done') - Number(b.status === 'Done');
    if (doneSort) return doneSort;
    return String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  }), [normalizedTasks]);
  const dailyTasks = sortedTasks.filter((task) => isTaskDueForDaily(task));
  const weeklyTasks = sortedTasks.filter((task) => task.frequency === 'Weekly' && isTaskOpen(task));
  const biMonthlyTasks = sortedTasks.filter((task) => task.frequency === 'Bi-Monthly' && isTaskOpen(task));
  const upcomingTasks = sortedTasks.filter((task) => isTaskOpen(task) && task.dueDate && String(task.dueDate) > String(todayISO()));
  const completedTasks = sortedTasks.filter((task) => task.status === 'Done');
  const overdueTasks = sortedTasks.filter((task) => isTaskOpen(task) && task.dueDate && String(task.dueDate) < String(todayISO()));
  const visibleTasks = filter === 'Daily'
    ? dailyTasks
    : filter === 'Weekly'
      ? weeklyTasks
      : filter === 'Bi-Monthly'
        ? biMonthlyTasks
        : filter === 'Upcoming'
          ? upcomingTasks
          : filter === 'Done'
            ? completedTasks
            : sortedTasks;

  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }

  function setQuickDate(days) {
    update('dueDate', addDaysISO(todayISO(), days));
  }

  function applyLinked(linkedType, linkedId) {
    let source;
    if (linkedType === 'Rental') source = (store.rentals || []).find((r) => r.id === linkedId);
    if (linkedType === 'Invoice') source = (store.invoices || []).find((i) => i.id === linkedId);
    if (linkedType === 'Customer') source = (store.customers || []).find((c) => c.id === linkedId);
    if (linkedType === 'Article') source = (store.articles || []).find((a) => a.id === linkedId);
    setForm((f) => {
      const next = { ...f, linkedType, linkedId };
      if (source) {
        next.customerName = source.customerName || source.name || source.articleName || '';
        next.mobile = source.mobile || '';
        if (!next.title) {
          if (linkedType === 'Rental') next.title = `Follow up ${source.customerName || 'customer'} for ${source.articleSnapshot || 'rental'}`;
          if (linkedType === 'Invoice') next.title = `Collect payment for ${source.invoiceNo || 'invoice'}`;
          if (linkedType === 'Customer') next.title = `Follow up ${source.name || 'customer'}`;
          if (linkedType === 'Article') next.title = `Check article ${source.articleName || source.articleCode || ''}`.trim();
        }
        if (linkedType === 'Rental' && source.expectedReturnDate) next.dueDate = source.expectedReturnDate;
        if (linkedType === 'Invoice' && source.dueDate) next.dueDate = source.dueDate;
      }
      return next;
    });
  }

  function submit(e) {
    e.preventDefault();
    if (!form.title || !form.dueDate) return notify('Task title and follow-up date are required');
    if (form.frequency !== 'One-time' && !isOwner) return notify('Only Owner can create recurring daily, weekly or bi-monthly tasks');
    const task = {
      ...form,
      id: uid('TSK'),
      frequency: form.frequency || 'One-time',
      autoCarryToDaily: form.autoCarryToDaily !== false,
      proofRequired: form.proofRequired !== false,
      proofText: '',
      proofFiles: [],
      status: 'Open',
      createdBy: currentUser?.full_name || currentUser?.email || 'User',
      createdByRole: currentUser?.role || '',
      createdAt: new Date().toISOString()
    };
    saveStore((prev) => ({ ...prev, tasks: [task, ...(prev.tasks || [])] }), `Task created: ${task.title}`, 'Tasks');
    setForm(freshTaskForm());
    notify(`${taskFrequencyLabel(task.frequency)} task saved. It will appear in Daily Tasks on ${fmtDate(task.dueDate)}.`);
  }

  function taskHasProof(task) {
    const draft = proofDrafts[task.id]?.text || '';
    return Boolean(String(task.proofText || '').trim() || String(draft).trim() || (task.proofFiles || []).length);
  }

  function proofByLabel() {
    return currentUser?.full_name || currentUser?.email || currentUser?.role || 'User';
  }

  function saveTextProof(task) {
    const text = String(proofDrafts[task.id]?.text || '').trim();
    if (!text) return notify('Write a proof reply before saving it');
    saveStore((prev) => ({
      ...prev,
      tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
        ...normalizeTask(t),
        proofText: text,
        proofUpdatedAt: new Date().toISOString(),
        proofUpdatedBy: proofByLabel()
      } : t)
    }), `Proof reply saved: ${task.title}`, 'Tasks');
    notify('Proof reply saved');
  }

  async function addProofFile(task, file) {
    if (!file) return;
    setProofUploadStatus((prev) => ({ ...prev, [task.id]: 'Uploading proof...' }));
    try {
      let uploaded;
      if (drive?.enabled && drive?.upload) {
        uploaded = await drive.upload(file, { label: `Task Proof ${task.title || task.id}` });
      } else {
        uploaded = await readFileAsDataUrl(file);
      }
      const proofFile = { ...uploaded, proofType: 'taskWorkProof', proofForTaskId: task.id, proofBy: proofByLabel(), proofAt: new Date().toISOString() };
      saveStore((prev) => ({
        ...prev,
        tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
          ...normalizeTask(t),
          proofFiles: [proofFile, ...(t.proofFiles || [])].slice(0, 12),
          proofUpdatedAt: new Date().toISOString(),
          proofUpdatedBy: proofByLabel()
        } : t)
      }), `Proof media uploaded: ${task.title}`, 'Tasks');
      setProofUploadStatus((prev) => ({ ...prev, [task.id]: `Proof saved in ${fileSourceLabel(proofFile)}: ${proofFile.name}` }));
    } catch (error) {
      if (drive?.localFallback) {
        const localFile = await readFileAsDataUrl(file);
        const proofFile = { ...localFile, proofType: 'taskWorkProof', proofForTaskId: task.id, proofBy: proofByLabel(), proofAt: new Date().toISOString() };
        saveStore((prev) => ({
          ...prev,
          tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
            ...normalizeTask(t),
            proofFiles: [proofFile, ...(t.proofFiles || [])].slice(0, 12),
            proofUpdatedAt: new Date().toISOString(),
            proofUpdatedBy: proofByLabel()
          } : t)
        }), `Proof media saved locally: ${task.title}`, 'Tasks');
        setProofUploadStatus((prev) => ({ ...prev, [task.id]: `Drive failed, proof saved locally: ${error.message}` }));
      } else {
        setProofUploadStatus((prev) => ({ ...prev, [task.id]: `Proof upload failed: ${error.message}` }));
      }
    }
  }

  function removeProofFile(task, fileIndex) {
    if (!isOwner) return notify('Only Owner can remove proof media');
    saveStore((prev) => ({
      ...prev,
      tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
        ...normalizeTask(t),
        proofFiles: (t.proofFiles || []).filter((_, i) => i !== fileIndex)
      } : t)
    }), `Owner removed proof media: ${task.title}`, 'Tasks');
  }

  function completeTask(task) {
    const normalized = normalizeTask(task);
    const draftText = String(proofDrafts[task.id]?.text || '').trim();
    const finalProofText = draftText || String(normalized.proofText || '').trim();
    const proofFiles = normalized.proofFiles || [];
    if (normalized.proofRequired !== false && !finalProofText && !proofFiles.length) {
      return notify('Proof required: add a photo/media proof or write a text reply before marking Done');
    }
    const proofEntry = {
      date: todayISO(),
      completedAt: new Date().toISOString(),
      by: proofByLabel(),
      text: finalProofText,
      files: proofFiles,
      linkedType: normalized.linkedType || 'Manual',
      linkedId: normalized.linkedId || ''
    };
    if (normalized.frequency && normalized.frequency !== 'One-time') {
      const nextDue = nextScheduledDateAfterToday(normalized.dueDate, normalized.frequency);
      saveStore((prev) => ({
        ...prev,
        tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
          ...normalizeTask(t),
          status: 'Open',
          dueDate: nextDue,
          proofText: '',
          proofFiles: [],
          proofUpdatedAt: '',
          proofUpdatedBy: '',
          lastCompletedAt: proofEntry.completedAt,
          lastCompletedBy: proofEntry.by,
          completedCount: toNumber(t.completedCount) + 1,
          completedHistory: [proofEntry, ...(t.completedHistory || [])].slice(0, 50)
        } : t)
      }), `Recurring task completed with proof and moved to ${fmtDate(nextDue)}`, 'Tasks');
      setProofDrafts((prev) => ({ ...prev, [task.id]: { text: '' } }));
      notify(`Done with proof. Next ${taskFrequencyLabel(normalized.frequency)} date set to ${fmtDate(nextDue)}.`);
      return;
    }
    saveStore((prev) => ({
      ...prev,
      tasks: (prev.tasks || []).map((t) => t.id === task.id ? {
        ...normalizeTask(t),
        status: 'Done',
        proofText: finalProofText,
        proofFiles,
        completedAt: proofEntry.completedAt,
        completedBy: proofEntry.by,
        completedHistory: [proofEntry, ...(t.completedHistory || [])].slice(0, 50)
      } : t)
    }), `Task marked Done with proof: ${normalized.title}`, 'Tasks');
    setProofDrafts((prev) => ({ ...prev, [task.id]: { text: '' } }));
  }

  function reopenTask(taskId) {
    saveStore((prev) => ({ ...prev, tasks: (prev.tasks || []).map((t) => t.id === taskId ? { ...normalizeTask(t), status: 'Open', completedAt: '', completedBy: '' } : t) }), 'Task reopened', 'Tasks');
  }

  function rescheduleTask(task, nextDate) {
    saveStore((prev) => ({ ...prev, tasks: (prev.tasks || []).map((t) => t.id === task.id ? { ...normalizeTask(t), dueDate: nextDate, status: 'Open', rescheduledAt: new Date().toISOString() } : t) }), `Task rescheduled to ${fmtDate(nextDate)}`, 'Tasks');
    notify(`Task moved to ${fmtDate(nextDate)}`);
  }

  function removeTask(task) {
    if (!isOwner) return notify('Only Owner can remove a task');
    if (!confirm(`Remove task: ${task.title}?`)) return;
    saveStore((prev) => ({ ...prev, tasks: (prev.tasks || []).filter((t) => t.id !== task.id) }), `Owner removed task: ${task.title}`, 'Tasks');
    notify('Task removed by Owner');
  }

  function proofPanel(task) {
    const draftText = proofDrafts[task.id]?.text ?? (task.proofText || '');
    const proofFiles = task.proofFiles || [];
    const lastHistory = task.completedHistory?.[0];
    return <div className="task-proof-box">
      <div className="task-proof-head">
        <b>Proof of work</b>
        <Badge tone={taskHasProof(task) ? 'green' : 'red'}>{taskHasProof(task) ? 'Proof added' : 'Required'}</Badge>
      </div>
      {task.status !== 'Done' && <>
        <textarea
          value={draftText}
          onChange={(e) => setProofDrafts((prev) => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), text: e.target.value } }))}
          placeholder="Staff reply: what was done, whom you met/called, article condition, payment update, next issue..."
        />
        <div className="task-proof-actions">
          <button type="button" className="ghost" onClick={() => saveTextProof(task)}>Save Text Proof</button>
          <label className="btn ghost upload-inline">Upload Photo/Media/PDF<input type="file" accept="image/*,video/*,.pdf" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; addProofFile(task, file); }} /></label>
        </div>
        {proofUploadStatus[task.id] && <small className="upload-status">{proofUploadStatus[task.id]}</small>}
      </>}
      {task.proofText && <div className="proof-reply"><small>Text proof by {task.proofUpdatedBy || task.completedBy || '-'}</small><p>{task.proofText}</p></div>}
      {proofFiles.length > 0 && <div className="proof-files">
        {proofFiles.map((file, index) => <span key={`${file.name}-${index}`} className="proof-chip"><FileLink file={file} label={file.type?.startsWith('image/') ? 'Photo proof' : file.type?.startsWith('video/') ? 'Video proof' : 'Proof file'} />{isOwner && task.status !== 'Done' && <button type="button" className="mini danger ghost" onClick={() => removeProofFile(task, index)}>×</button>}</span>)}
      </div>}
      {lastHistory && task.frequency !== 'One-time' && <details className="proof-history"><summary>Last completed proof history</summary><div><small>{fmtDate(lastHistory.date)} · {lastHistory.by}</small>{lastHistory.text && <p>{lastHistory.text}</p>}{(lastHistory.files || []).map((file, index) => <FileLink key={index} file={file} label={`Proof file ${index + 1}`} />)}</div></details>}
    </div>;
  }

  function taskRow(task) {
    const cls = classifyTask(task);
    const carried = isTaskDueForDaily(task) && task.autoCarryToDaily !== false && task.status !== 'Done';
    return <tr key={task.id}>
      <td><Badge tone={cls.tone}>{cls.label}</Badge>{carried && <small>Carried to daily</small>}{task.proofRequired !== false && <small>Proof required</small>}</td>
      <td>{task.title}<small>{task.priority} · {taskFrequencyLabel(task.frequency)} · {task.linkedType || 'Manual'}</small></td>
      <td>{fmtDate(task.dueDate)}<small>{task.frequency !== 'One-time' ? 'Auto next date after Done' : 'One-time follow-up'}</small></td>
      <td>{task.assignedTo || '-'}</td>
      <td>{task.customerName || '-'}<small>{task.mobile || ''}</small></td>
      <td>{task.notes || '-'}{task.completedCount ? <small>Completed {task.completedCount} time(s)</small> : null}{proofPanel(task)}</td>
      <td><div className="row-actions">
        {task.status === 'Done' ? <button className="ghost" onClick={() => reopenTask(task.id)}>Reopen</button> : <button className="ghost" disabled={task.proofRequired !== false && !taskHasProof(task)} onClick={() => completeTask(task)}>Done</button>}
        {task.status !== 'Done' && <button className="ghost" onClick={() => rescheduleTask(task, addDaysISO(todayISO(), 1))}>Tomorrow</button>}
        {task.frequency !== 'One-time' && task.status !== 'Done' && <button className="ghost" onClick={() => rescheduleTask(task, nextScheduledDateAfterToday(task.dueDate, task.frequency))}>Next</button>}
        {task.mobile && <a className="btn ghost" target="_blank" rel="noreferrer" href={waLink(task.mobile, `${task.title}
Due: ${fmtDate(task.dueDate)}
${task.notes || ''}`)}>WhatsApp</a>}
        {isOwner && <button className="danger ghost" onClick={() => removeTask(task)}>Remove</button>}
      </div></td>
    </tr>;
  }


  return (
    <>
      <div className="stats-grid">
        <StatCard label="Daily Tasks" value={dailyTasks.length} hint="Due today + overdue follow-ups" tone={dailyTasks.length ? 'orange' : 'green'} />
        <StatCard label="Overdue Carry Forward" value={overdueTasks.length} hint="Still pending from past dates" tone={overdueTasks.length ? 'red' : 'green'} />
        <StatCard label="Weekly Tasks" value={weeklyTasks.length} hint="Auto scheduled every 7 days" tone="blue" />
        <StatCard label="Bi-Monthly Tasks" value={biMonthlyTasks.length} hint="Auto scheduled every 15 days" tone="blue" />
      </div>

      <Section title="Task Scheduler" subtitle="Create one-time, daily, weekly and bi-monthly follow-ups. Due tasks automatically appear in Daily Tasks on their date and remain there until completed.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Task Title" required><input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="Call client / pickup article / collect payment" /></Field>
          <Field label="Schedule"><select value={form.frequency} onChange={(e) => update('frequency', e.target.value)}>{taskFrequencies.filter((f) => isOwner || f === 'One-time').map((f) => <option key={f} value={f}>{taskFrequencyLabel(f)}</option>)}</select></Field>
          <Field label="Follow-up / First Date" required><input type="date" value={form.dueDate} onChange={(e) => update('dueDate', e.target.value)} /></Field>
          <Field label="Priority"><select value={form.priority} onChange={(e) => update('priority', e.target.value)}><option>High</option><option>Medium</option><option>Low</option></select></Field>
          <Field label="Assigned To"><select value={form.assignedTo} onChange={(e) => update('assignedTo', e.target.value)}><option>Owner</option><option>Operations Manager</option><option>Field Staff</option><option>Driver</option><option>Accountant</option></select></Field>
          <Field label="Linked Type"><select value={form.linkedType} onChange={(e) => applyLinked(e.target.value, '')}><option>Rental</option><option>Invoice</option><option>Customer</option><option>Article</option><option>Manual</option></select></Field>
          <Field label="Linked Record"><select value={form.linkedId} onChange={(e) => applyLinked(form.linkedType, e.target.value)}><option value="">Not linked</option>{form.linkedType === 'Rental' && (store.rentals || []).map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.customerName} · {r.articleSnapshot}</option>)}{form.linkedType === 'Invoice' && (store.invoices || []).map((i) => <option key={i.id} value={i.id}>{i.invoiceNo} · {i.customerName} · Due {money(invoiceBalance(i, store.payments || []))}</option>)}{form.linkedType === 'Customer' && (store.customers || []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.mobile}</option>)}{form.linkedType === 'Article' && (store.articles || []).map((a) => <option key={a.id} value={a.id}>{a.articleCode || a.id} · {a.articleName}</option>)}</select></Field>
          <Field label="Customer / Party"><input value={form.customerName} onChange={(e) => update('customerName', e.target.value)} /></Field>
          <Field label="Mobile"><input value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 12))} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <label className="terms wide"><input type="checkbox" checked={form.autoCarryToDaily} onChange={(e) => update('autoCarryToDaily', e.target.checked)} /> <span>Carry this task automatically into Daily Tasks when its follow-up date arrives</span></label>
          <label className="terms wide"><input type="checkbox" checked={form.proofRequired !== false} onChange={(e) => update('proofRequired', e.target.checked)} /> <span>Require staff proof before marking this task Done</span></label>
          <div className="form-actions wide"><button type="submit">Save Scheduled Task</button><button type="button" className="ghost" onClick={() => setQuickDate(0)}>Today</button><button type="button" className="ghost" onClick={() => setQuickDate(1)}>Tomorrow</button><button type="button" className="ghost" onClick={() => setQuickDate(7)}>+7 Days</button><button type="button" className="ghost" onClick={() => setQuickDate(15)}>+15 Days</button></div>
        </form>
      </Section>

      <Section title="Daily / Weekly / Bi-Monthly Task Lists" subtitle="Daily list is automatic: every follow-up whose date is today or earlier is carried forward here until done. Only Owner can remove tasks.">
        <div className="filter-row task-filter-row">
          {['Daily', 'Weekly', 'Bi-Monthly', 'Upcoming', 'Done', 'All'].map((item) => <button key={item} className={filter === item ? 'active' : 'ghost'} onClick={() => setFilter(item)}>{item}</button>)}
        </div>
        <div className="task-rule-card">
          <b>Carry-forward rule</b>
          <p>A task dated today appears in Daily Tasks automatically. If it is not completed, it stays in Daily Tasks as overdue. Staff must add text proof or photo/media proof before Done. Recurring tasks move to their next date only after proof-backed completion.</p>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Status</th><th>Task</th><th>Follow-up Date</th><th>Assigned</th><th>Party</th><th>Notes</th><th>Action</th></tr></thead><tbody>{visibleTasks.map(taskRow)}</tbody></table>{visibleTasks.length === 0 && <Empty text={`No ${filter.toLowerCase()} tasks found.`} />}</div>
      </Section>
    </>
  );
}

function DeliveryPickupCenter({ store, saveStore, notify }) {
  const [form, setForm] = useState({ type: 'Delivery', rentalId: '', issueNo: '', customerName: '', mobile: '', articleName: '', scheduledDate: todayISO(), scheduledTime: '10:00', fromLocation: 'Shop', toLocation: '', vehicle: '', driver: '', assignedStaff: 'Field Staff', charge: '', status: 'Scheduled', notes: '' });
  const movements = [...(store.movements || [])].sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)) || String(a.scheduledTime).localeCompare(String(b.scheduledTime)));
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function selectRental(id) {
    const r = (store.rentals || []).find((x) => x.id === id);
    if (!r) return update('rentalId', id);
    setForm((f) => ({ ...f, rentalId: id, issueNo: r.issueNo, customerName: r.customerName, mobile: r.mobile, articleName: r.articleSnapshot, toLocation: r.siteName || r.address || '', fromLocation: f.type === 'Pickup' ? (r.siteName || r.address || '') : 'Shop' }));
  }
  function submit(e) {
    e.preventDefault();
    if (!form.customerName || !form.scheduledDate) return notify('Party and date are required');
    const movement = { ...form, id: uid('MOV'), charge: toNumber(form.charge), createdAt: new Date().toISOString() };
    saveStore((prev) => ({ ...prev, movements: [movement, ...(prev.movements || [])] }), `${movement.type} scheduled for ${movement.customerName}`, 'Delivery/Pickup');
    notify('Delivery/pickup scheduled');
  }
  function updateStatus(id, status) {
    saveStore((prev) => ({ ...prev, movements: (prev.movements || []).map((m) => m.id === id ? { ...m, status, completedAt: status === 'Completed' ? new Date().toISOString() : m.completedAt } : m) }), `Movement marked ${status}`, 'Delivery/Pickup');
  }
  return (
    <>
      <Section title="Delivery / Pickup Scheduler" subtitle="Plan dispatch, pickup, driver/staff assignment and movement charges.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Movement Type"><select value={form.type} onChange={(e) => { const type = e.target.value; setForm((f) => ({ ...f, type, fromLocation: type === 'Pickup' ? f.toLocation : 'Shop', toLocation: type === 'Pickup' ? 'Shop' : f.toLocation })); }}><option>Delivery</option><option>Pickup</option><option>Exchange</option><option>Repair Drop</option><option>Repair Pickup</option></select></Field>
          <Field label="Linked Rental"><select value={form.rentalId} onChange={(e) => selectRental(e.target.value)}><option value="">Manual</option>{(store.rentals || []).map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.customerName} · {r.articleSnapshot}</option>)}</select></Field>
          <Field label="Party"><input value={form.customerName} onChange={(e) => update('customerName', e.target.value)} /></Field>
          <Field label="Mobile"><input value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 12))} /></Field>
          <Field label="Article"><input value={form.articleName} onChange={(e) => update('articleName', e.target.value)} /></Field>
          <Field label="Date"><input type="date" value={form.scheduledDate} onChange={(e) => update('scheduledDate', e.target.value)} /></Field>
          <Field label="Time"><input type="time" value={form.scheduledTime} onChange={(e) => update('scheduledTime', e.target.value)} /></Field>
          <Field label="From"><input value={form.fromLocation} onChange={(e) => update('fromLocation', e.target.value)} /></Field>
          <Field label="To"><input value={form.toLocation} onChange={(e) => update('toLocation', e.target.value)} /></Field>
          <Field label="Vehicle"><input value={form.vehicle} onChange={(e) => update('vehicle', e.target.value)} placeholder="Tempo / bike / van" /></Field>
          <Field label="Driver"><input value={form.driver} onChange={(e) => update('driver', e.target.value)} /></Field>
          <Field label="Assigned Staff"><input value={form.assignedStaff} onChange={(e) => update('assignedStaff', e.target.value)} /></Field>
          <Field label="Charge"><input type="number" value={form.charge} onChange={(e) => update('charge', e.target.value)} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">Schedule Movement</button></div>
        </form>
      </Section>
      <Section title="Movement Register" subtitle="Pending and completed delivery/pickup movements.">
        <div className="table-wrap"><table><thead><tr><th>Date/Time</th><th>Type</th><th>Party</th><th>Article</th><th>Route</th><th>Vehicle/Staff</th><th>Charge</th><th>Status</th><th>Action</th></tr></thead><tbody>{movements.map((m) => <tr key={m.id}><td>{fmtDate(m.scheduledDate)}<small>{m.scheduledTime}</small></td><td>{m.type}<small>{m.issueNo}</small></td><td>{m.customerName}<small>{m.mobile}</small></td><td>{m.articleName || '-'}</td><td>{m.fromLocation} → {m.toLocation}</td><td>{m.vehicle || '-'}<small>{m.driver || m.assignedStaff}</small></td><td>{money(m.charge)}</td><td><Badge tone={m.status === 'Completed' ? 'green' : m.status === 'Cancelled' ? 'red' : 'blue'}>{m.status}</Badge></td><td><div className="row-actions"><button className="ghost" onClick={() => updateStatus(m.id, 'Completed')}>Complete</button><button className="danger ghost" onClick={() => updateStatus(m.id, 'Cancelled')}>Cancel</button>{m.mobile && <a className="btn ghost" target="_blank" rel="noreferrer" href={waLink(m.mobile, `${m.type} scheduled on ${fmtDate(m.scheduledDate)} ${m.scheduledTime}\nArticle: ${m.articleName}\nRoute: ${m.fromLocation} to ${m.toLocation}`)}>WhatsApp</a>}</div></td></tr>)}</tbody></table>{movements.length === 0 && <Empty text="No movement scheduled yet." />}</div>
      </Section>
    </>
  );
}

function VendorPurchaseCenter({ store, saveStore, notify }) {
  const [vendor, setVendor] = useState({ name: '', type: 'Material Vendor', mobile: '', gstin: '', address: '', categories: '', rating: 4, paymentTerms: '', notes: '' });
  const [po, setPo] = useState({ vendorId: '', date: todayISO(), expectedDate: addDaysISO(todayISO(), 2), status: 'Draft', item: '', linkedArticleId: '', qty: 1, rate: '', taxPercent: store.settings.defaultGstPercent || 18, paidAmount: 0, notes: '' });
  const vendors = store.vendors || [];
  const purchaseOrders = store.purchaseOrders || [];
  const poTotal = (row) => toNumber(row.qty) * toNumber(row.rate) + percentAmount(toNumber(row.qty) * toNumber(row.rate), row.taxPercent);
  function saveVendor(e) {
    e.preventDefault();
    if (!vendor.name || !vendor.mobile) return notify('Vendor name and mobile required');
    const row = { ...vendor, id: uid('VEN'), rating: toNumber(vendor.rating), createdAt: new Date().toISOString() };
    saveStore((prev) => ({ ...prev, vendors: [row, ...(prev.vendors || [])] }), `Vendor added: ${row.name}`, 'Vendor');
    setVendor({ name: '', type: 'Material Vendor', mobile: '', gstin: '', address: '', categories: '', rating: 4, paymentTerms: '', notes: '' });
    notify('Vendor saved');
  }
  function savePo(e) {
    e.preventDefault();
    const ven = vendors.find((v) => v.id === po.vendorId);
    if (!po.vendorId || !po.item) return notify('Vendor and item required');
    const row = { ...po, id: uid('PO'), poNo: nextNumber('PO', purchaseOrders, 'poNo'), vendorName: ven?.name || '', qty: toNumber(po.qty), rate: toNumber(po.rate), taxPercent: toNumber(po.taxPercent), paidAmount: toNumber(po.paidAmount), createdAt: new Date().toISOString() };
    saveStore((prev) => ({ ...prev, purchaseOrders: [row, ...(prev.purchaseOrders || [])] }), `Purchase order created: ${row.poNo}`, 'Purchase');
    setPo({ vendorId: '', date: todayISO(), expectedDate: addDaysISO(todayISO(), 2), status: 'Draft', item: '', linkedArticleId: '', qty: 1, rate: '', taxPercent: store.settings.defaultGstPercent || 18, paidAmount: 0, notes: '' });
    notify('Purchase order saved');
  }
  function poStatus(id, status) {
    saveStore((prev) => ({ ...prev, purchaseOrders: (prev.purchaseOrders || []).map((x) => x.id === id ? { ...x, status } : x) }), `Purchase order marked ${status}`, 'Purchase');
  }
  function markPaid(row) {
    const total = poTotal(row);
    saveStore((prev) => ({ ...prev, purchaseOrders: (prev.purchaseOrders || []).map((x) => x.id === row.id ? { ...x, paidAmount: total, status: x.status === 'Received' ? 'Closed' : x.status } : x), expenses: [{ id: uid('EXP'), date: todayISO(), category: 'Purchase / Service', paidTo: row.vendorName, amount: total, mode: 'UPI', linkedArticleId: row.linkedArticleId, linkedRentalId: '', notes: `Payment against ${row.poNo}: ${row.item}`, createdAt: new Date().toISOString() }, ...(prev.expenses || [])] }), `Purchase order paid: ${row.poNo}`, 'Purchase');
    notify('PO marked paid and expense added');
  }
  return (
    <>
      <div className="two-col">
        <Section title="Vendor Master" subtitle="Useful for sample catalogues, tool purchase, repair, spare parts and transport vendors.">
          <form className="form-grid" onSubmit={saveVendor}>
            <Field label="Vendor Name" required><input value={vendor.name} onChange={(e) => setVendor((f) => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Type"><select value={vendor.type} onChange={(e) => setVendor((f) => ({ ...f, type: e.target.value }))}><option>Material Vendor</option><option>Tool Vendor</option><option>Repair Vendor</option><option>Transporter</option><option>Other</option></select></Field>
            <Field label="Mobile" required><input value={vendor.mobile} onChange={(e) => setVendor((f) => ({ ...f, mobile: e.target.value.replace(/\D/g, '').slice(0, 12) }))} /></Field>
            <Field label="GSTIN"><input value={vendor.gstin} onChange={(e) => setVendor((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} /></Field>
            <Field label="Categories"><input value={vendor.categories} onChange={(e) => setVendor((f) => ({ ...f, categories: e.target.value }))} placeholder="Drill, cutter, mica catalogue" /></Field>
            <Field label="Rating"><input type="number" min="1" max="5" value={vendor.rating} onChange={(e) => setVendor((f) => ({ ...f, rating: e.target.value }))} /></Field>
            <Field label="Address"><textarea value={vendor.address} onChange={(e) => setVendor((f) => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Payment Terms"><textarea value={vendor.paymentTerms} onChange={(e) => setVendor((f) => ({ ...f, paymentTerms: e.target.value }))} /></Field>
            <Field label="Notes"><textarea value={vendor.notes} onChange={(e) => setVendor((f) => ({ ...f, notes: e.target.value }))} /></Field>
            <div className="form-actions wide"><button type="submit">Save Vendor</button></div>
          </form>
        </Section>

        <Section title="Purchase / Service Order" subtitle="Track purchase of rental articles, catalogues, spare parts, repair service and transport bills.">
          <form className="form-grid" onSubmit={savePo}>
            <Field label="Vendor" required><select value={po.vendorId} onChange={(e) => setPo((f) => ({ ...f, vendorId: e.target.value }))}><option value="">Select vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="Date"><input type="date" value={po.date} onChange={(e) => setPo((f) => ({ ...f, date: e.target.value }))} /></Field>
            <Field label="Expected Date"><input type="date" value={po.expectedDate} onChange={(e) => setPo((f) => ({ ...f, expectedDate: e.target.value }))} /></Field>
            <Field label="Item" required><input value={po.item} onChange={(e) => setPo((f) => ({ ...f, item: e.target.value }))} placeholder="Drill / catalogue / spare part" /></Field>
            <Field label="Linked Article"><select value={po.linkedArticleId} onChange={(e) => setPo((f) => ({ ...f, linkedArticleId: e.target.value }))}><option value="">Not linked</option>{(store.articles || []).map((a) => <option key={a.id} value={a.id}>{a.articleName}</option>)}</select></Field>
            <Field label="Qty"><input type="number" value={po.qty} onChange={(e) => setPo((f) => ({ ...f, qty: e.target.value }))} /></Field>
            <Field label="Rate"><input type="number" value={po.rate} onChange={(e) => setPo((f) => ({ ...f, rate: e.target.value }))} /></Field>
            <Field label="Tax %"><input type="number" value={po.taxPercent} onChange={(e) => setPo((f) => ({ ...f, taxPercent: e.target.value }))} /></Field>
            <Field label="Paid Amount"><input type="number" value={po.paidAmount} onChange={(e) => setPo((f) => ({ ...f, paidAmount: e.target.value }))} /></Field>
            <Field label="Notes"><textarea value={po.notes} onChange={(e) => setPo((f) => ({ ...f, notes: e.target.value }))} /></Field>
            <div className="form-actions wide"><button type="submit">Save Purchase Order</button></div>
          </form>
        </Section>
      </div>

      <Section title="Vendor Directory" subtitle="Searchable vendor/contact list for daily operations.">
        <div className="table-wrap"><table><thead><tr><th>Vendor</th><th>Type</th><th>Mobile</th><th>Categories</th><th>Rating</th><th>Payment Terms</th></tr></thead><tbody>{vendors.map((v) => <tr key={v.id}><td>{v.name}<small>{v.address}</small></td><td>{v.type}</td><td>{v.mobile}</td><td>{v.categories}</td><td>{'★'.repeat(Math.max(1, Math.min(5, toNumber(v.rating))))}</td><td>{v.paymentTerms || '-'}</td></tr>)}</tbody></table>{vendors.length === 0 && <Empty text="No vendor saved yet." />}</div>
      </Section>

      <Section title="Purchase Order Register" subtitle="Vendor payable, expected material/service and payment status.">
        <div className="table-wrap"><table><thead><tr><th>PO</th><th>Vendor</th><th>Item</th><th>Date</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead><tbody>{purchaseOrders.map((row) => { const total = poTotal(row); const bal = Math.max(0, total - toNumber(row.paidAmount)); return <tr key={row.id}><td>{row.poNo}<small>Expected {fmtDate(row.expectedDate)}</small></td><td>{row.vendorName}</td><td>{row.item}<small>{row.notes}</small></td><td>{fmtDate(row.date)}</td><td>{money(total)}</td><td>{money(row.paidAmount)}</td><td>{money(bal)}</td><td><Badge tone={row.status === 'Closed' || row.status === 'Received' ? 'green' : row.status === 'Cancelled' ? 'red' : 'blue'}>{row.status}</Badge></td><td><div className="row-actions"><button className="ghost" onClick={() => poStatus(row.id, 'Ordered')}>Ordered</button><button className="ghost" onClick={() => poStatus(row.id, 'Received')}>Received</button><button className="ghost" onClick={() => markPaid(row)}>Mark Paid</button><button className="danger ghost" onClick={() => poStatus(row.id, 'Cancelled')}>Cancel</button></div></td></tr>; })}</tbody></table>{purchaseOrders.length === 0 && <Empty text="No purchase order yet." />}</div>
      </Section>
    </>
  );
}

function ArticleMaster({ store, saveStore, notify, editingArticle, setEditingArticle, query, setQuery, articleAvailableQty, drive, onOpenTrace }) {
  const [form, setForm] = useState(emptyForm());

  useEffect(() => {
    if (editingArticle) {
      setForm({ ...emptyForm(), ...editingArticle, accessoriesText: (editingArticle.accessories || []).join('\n') });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [editingArticle]);

  const filtered = store.articles.filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [a.articleName, a.articleCode, a.category, a.subcategory, a.brand, a.articleType, a.vendorName].join(' ').toLowerCase().includes(q);
  });

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.articleName || !form.category || !form.articleCode) return notify('Article name, code and category are required');
    const payload = {
      ...form,
      qtyTotal: Math.max(1, toNumber(form.qtyTotal)),
      purchaseCost: toNumber(form.purchaseCost),
      rentRate: toNumber(form.rentRate),
      depositDefault: toNumber(form.depositDefault),
      replacementCost: toNumber(form.replacementCost),
      maintenanceEveryDays: toNumber(form.maintenanceEveryDays) || 30,
      accessories: String(form.accessoriesText || '').split('\n').map((x) => x.trim()).filter(Boolean),
      updatedAt: new Date().toISOString()
    };
    delete payload.accessoriesText;
    saveStore((prev) => {
      const exists = prev.articles.some((a) => a.id === payload.id);
      const article = exists ? payload : { ...payload, id: uid('ART'), createdAt: new Date().toISOString() };
      return { ...prev, articles: exists ? prev.articles.map((a) => a.id === article.id ? article : a) : [article, ...prev.articles] };
    });
    setForm(emptyForm());
    setEditingArticle(null);
    notify(editingArticle ? 'Article updated' : 'Article added');
  }

  function duplicateArticle(article) {
    const copy = { ...article, id: undefined, articleCode: `${article.articleCode}-COPY`, serialNumber: '', createdAt: undefined, updatedAt: undefined };
    setEditingArticle(copy);
  }

  return (
    <>
      <Section title={editingArticle ? 'Edit Rental Article' : 'Add Rental Article'} subtitle="Create clean master data before issuing any item on rent.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Article Type" required><select value={form.articleType} onChange={(e) => update('articleType', e.target.value)}>{articleTypes.map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Article Code" required><input value={form.articleCode} onChange={(e) => update('articleCode', e.target.value.toUpperCase())} placeholder="TOOL-DRILL-001" /></Field>
          <Field label="Article Name" required><input value={form.articleName} onChange={(e) => update('articleName', e.target.value)} placeholder="Drill machine / Mica catalogue" /></Field>
          <Field label="Category" required><input value={form.category} onChange={(e) => update('category', e.target.value)} placeholder="Electrical Tool / Laminate" /></Field>
          <Field label="Subcategory"><input value={form.subcategory} onChange={(e) => update('subcategory', e.target.value)} placeholder="Drilling / 1mm Mica" /></Field>
          <Field label="Brand / Vendor Brand"><input value={form.brand} onChange={(e) => update('brand', e.target.value)} placeholder="Bosch / Greenlam" /></Field>
          <Field label="Model / Size / Sample Count"><input value={form.modelSize} onChange={(e) => update('modelSize', e.target.value)} placeholder="13mm / 80 samples" /></Field>
          <Field label="Serial Number"><input value={form.serialNumber} onChange={(e) => update('serialNumber', e.target.value)} placeholder="If available" /></Field>
          <Field label="Purchase Date"><input type="date" value={form.purchaseDate} onChange={(e) => update('purchaseDate', e.target.value)} /></Field>
          <Field label="Purchase Cost"><input type="number" value={form.purchaseCost} onChange={(e) => update('purchaseCost', e.target.value)} placeholder="4500" /></Field>
          <Field label="Total Quantity" required><input type="number" min="1" value={form.qtyTotal} onChange={(e) => update('qtyTotal', e.target.value)} /></Field>
          <Field label="Current Location"><input value={form.currentLocation} onChange={(e) => update('currentLocation', e.target.value)} placeholder="Shop / Godown" /></Field>
          <Field label="Condition"><select value={form.condition} onChange={(e) => update('condition', e.target.value)}>{conditionOptions.map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Stock Status"><select value={form.status} onChange={(e) => update('status', e.target.value)}>{articleStatus.map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Rent Unit"><select value={form.rentUnit} onChange={(e) => update('rentUnit', e.target.value)}>{rentUnits.map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Rent Rate"><input type="number" value={form.rentRate} onChange={(e) => update('rentRate', e.target.value)} placeholder="200" /></Field>
          <Field label="Default Deposit"><input type="number" value={form.depositDefault} onChange={(e) => update('depositDefault', e.target.value)} placeholder="1000" /></Field>
          <Field label="Replacement Cost"><input type="number" value={form.replacementCost} onChange={(e) => update('replacementCost', e.target.value)} placeholder="Full loss charge" /></Field>
          <Field label="Vendor / Supplier"><input value={form.vendorName} onChange={(e) => update('vendorName', e.target.value)} /></Field>
          <Field label="Warranty Till"><input type="date" value={form.warrantyTill} onChange={(e) => update('warrantyTill', e.target.value)} /></Field>
          <Field label="Maintenance Every Days"><input type="number" min="1" value={form.maintenanceEveryDays} onChange={(e) => update('maintenanceEveryDays', e.target.value)} /></Field>
          <Field label="Accessories / Sample Pieces"><textarea value={form.accessoriesText} onChange={(e) => update('accessoriesText', e.target.value)} placeholder="One per line: Chuck key, drill bits, box" /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Damage rule, special instruction" /></Field>
          <FileInput label="Article Photo" onFile={(file) => update('photo', file)} drive={drive} />
          <FileInput label="Purchase Bill Photo/PDF" onFile={(file) => update('purchaseBill', file)} accept="image/*,.pdf" drive={drive} />
          <div className="form-actions wide">
            <button type="submit">{editingArticle ? 'Update Article' : 'Save Article'}</button>
            <button type="button" className="ghost" onClick={() => { setForm(emptyForm()); setEditingArticle(null); }}>Clear Form</button>
          </div>
        </form>
      </Section>

      <Section title="Article Stock Register" subtitle="Search, edit and verify available stock." right={<input className="search" placeholder="Search article/category/vendor" value={query} onChange={(e) => setQuery(e.target.value)} />}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Article</th><th>Type</th><th>Qty</th><th>Rent/Deposit</th><th>Condition</th><th>Bill</th><th>Action</th></tr></thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.articleName}</b><small>{a.articleCode} · {a.brand} · {a.category} / {a.subcategory || '-'}</small></td>
                  <td>{a.articleType}</td>
                  <td><b>{articleAvailableQty(a.id)}</b> available / {a.qtyTotal}</td>
                  <td>{money(a.rentRate)} / {a.rentUnit}<small>Deposit {money(a.depositDefault)}</small></td>
                  <td><Badge tone={a.status === 'Available' ? 'green' : ['Damaged', 'Lost', 'In Repair'].includes(a.status) ? 'red' : 'gray'}>{a.status}</Badge><small>{a.condition}</small></td>
                  <td>{a.purchaseBill ? <FileLink file={a.purchaseBill} label="View bill" /> : '-'}</td>
                  <td className="row-actions"><button className="ghost" onClick={() => onOpenTrace?.(a.id)}>Trace</button><button className="ghost" onClick={() => setEditingArticle(a)}>Edit</button><button className="ghost" onClick={() => duplicateArticle(a)}>Duplicate</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <Empty text="No article found." />}
        </div>
      </Section>
    </>
  );
}

function IssueArticle({ store, saveStore, notify, articleAvailableQty, drive }) {
  const [form, setForm] = useState({
    articleId: '', quantity: 1, customerType: 'Contractor', customerName: '', mobile: '', alternateMobile: '', address: '', siteName: '', linkedClient: '', purpose: '', issueDate: todayISO(), expectedReturnDate: todayISO(), rentRate: '', rentUnit: 'Day', deposit: '', advancePaid: '', deliveryCharge: '', paymentMode: 'Cash', issuedBy: 'Owner', conditionBefore: 'Good', checklist: {}, accessoriesIssued: [], termsAccepted: false, notes: '', idProof: null, beforePhotos: []
  });

  const selected = store.articles.find((a) => a.id === form.articleId);
  const beforeItems = selected?.articleType === 'Interior Sample / Catalogue' ? CHECKLISTS.sampleBefore : CHECKLISTS.toolBefore;
  const available = selected ? articleAvailableQty(selected.id) : 0;

  useEffect(() => {
    if (!selected) return;
    setForm((f) => ({
      ...f,
      rentRate: selected.rentRate || 0,
      rentUnit: selected.rentUnit || 'Day',
      deposit: selected.depositDefault || 0,
      accessoriesIssued: (selected.accessories || []).map((name) => ({ name, issued: true, returned: false })),
      checklist: Object.fromEntries((selected.articleType === 'Interior Sample / Catalogue' ? CHECKLISTS.sampleBefore : CHECKLISTS.toolBefore).map((x) => [x, false]))
    }));
  }, [form.articleId]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function addBeforePhoto(file) {
    if (!file) return;
    setForm((f) => ({ ...f, beforePhotos: [...(f.beforePhotos || []), file] }));
  }

  function setAccessory(index, value) {
    setForm((f) => ({ ...f, accessoriesIssued: f.accessoriesIssued.map((a, i) => i === index ? { ...a, issued: value } : a) }));
  }

  function printSlip(rental) {
    const article = store.articles.find((a) => a.id === rental.articleId);
    const accessories = (rental.accessoriesIssued || []).filter((x) => x.issued).map((x) => `• ${escapeHtml(x.name)}`).join('<br/>') || '-';
    const html = `
        <h1>Rental Issue Slip</h1><small>${escapeHtml(rental.issueNo)}</small>
        <div class="box"><b>Article:</b> ${escapeHtml(article?.articleName || rental.articleSnapshot)}<br/><b>Code:</b> ${escapeHtml(article?.articleCode || '-')}<br/><b>Qty:</b> ${escapeHtml(rental.quantity)}</div>
        <div class="grid"><div><b>Issued To:</b> ${escapeHtml(rental.customerName)}</div><div><b>Mobile:</b> ${escapeHtml(rental.mobile)}</div><div><b>Site:</b> ${escapeHtml(rental.siteName)}</div><div><b>Type:</b> ${escapeHtml(rental.customerType)}</div><div><b>Issue Date:</b> ${escapeHtml(fmtDate(rental.issueDate))}</div><div><b>Return Date:</b> ${escapeHtml(fmtDate(rental.expectedReturnDate))}</div><div><b>Rent:</b> ${money(rental.rentRate)} / ${escapeHtml(rental.rentUnit)}</div><div><b>Deposit:</b> ${money(rental.deposit)}</div></div>
        <div class="box"><b>Accessories:</b><br/>${accessories}</div>
        <div class="box"><b>Terms:</b><br/>Late return, damage, missing accessory, or lost article will be charged from deposit or payable balance. Article must be returned in the same condition.</div>
        <p>Customer Signature: ____________________ &nbsp;&nbsp; Received By: ____________________</p>`;
    printDocument(`Issue Slip ${rental.issueNo}`, `<style>.box{border:1px solid #222;padding:14px;margin:12px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}</style>${html}`);
  }

  function submit(e) {
    e.preventDefault();
    if (!selected) return notify('Select article');
    const issueCheck = canIssueQuantity({ requestedQty: form.quantity, availableQty: available });
    if (!issueCheck.ok) return notify(issueCheck.reason);
    if (!form.customerName || !form.mobile || !form.siteName) return notify('Customer name, mobile and site are required');
    if (!form.expectedReturnDate) return notify('Expected return date is required');
    if (!form.termsAccepted) return notify('Terms must be accepted before issue');

    const rental = {
      ...form,
      id: uid('REN'),
      issueNo: `${store.settings.receiptPrefix || 'ISS'}-${String(store.rentals.length + 1001)}`,
      quantity: toNumber(form.quantity),
      quantityReturned: 0,
      rentRate: toNumber(form.rentRate),
      deposit: toNumber(form.deposit),
      advancePaid: toNumber(form.advancePaid),
      deliveryCharge: toNumber(form.deliveryCharge),
      articleSnapshot: selected.articleName,
      status: 'Active',
      createdAt: new Date().toISOString()
    };

    const payment = toNumber(rental.advancePaid) > 0 ? [{ id: uid('PAY'), rentalId: rental.id, articleId: rental.articleId, type: 'Advance Rent', amount: rental.advancePaid, mode: rental.paymentMode, date: rental.issueDate, receivedBy: rental.issuedBy, notes: 'Auto-added from issue form' }] : [];
    const depositPay = toNumber(rental.deposit) > 0 ? [{ id: uid('PAY'), rentalId: rental.id, articleId: rental.articleId, type: 'Deposit Collected', amount: rental.deposit, mode: rental.paymentMode, date: rental.issueDate, receivedBy: rental.issuedBy, notes: 'Refundable security deposit' }] : [];

    saveStore((prev) => ({
      ...prev,
      rentals: [rental, ...prev.rentals],
      payments: [...payment, ...depositPay, ...prev.payments],
      articles: prev.articles.map((a) => a.id === selected.id ? { ...a, status: articleAvailableQty(selected.id) - rental.quantity <= 0 ? 'Issued' : a.status } : a)
    }));
    setForm({ articleId: '', quantity: 1, customerType: 'Contractor', customerName: '', mobile: '', alternateMobile: '', address: '', siteName: '', linkedClient: '', purpose: '', issueDate: todayISO(), expectedReturnDate: todayISO(), rentRate: '', rentUnit: 'Day', deposit: '', advancePaid: '', deliveryCharge: '', paymentMode: 'Cash', issuedBy: 'Owner', conditionBefore: 'Good', checklist: {}, accessoriesIssued: [], termsAccepted: false, notes: '', idProof: null, beforePhotos: [] });
    notify('Article issued');
    setTimeout(() => printSlip(rental), 100);
  }

  return (
    <Section title="Issue Article on Rent" subtitle="Guided flow: select stock, link customer/site, collect deposit, upload proof, then print issue slip.">
      <WorkflowSteps steps={["Article", "Customer/Site", "Rent & Deposit", "Proof", "Confirm Slip"]} current={selected ? (form.customerName && form.mobile ? (form.deposit || form.advancePaid ? ((form.beforePhotos || []).length || form.idProof ? 4 : 3) : 2) : 1) : 1} />
      <form className="form-grid" onSubmit={submit}>
        <Field label="Article" required>
          <select value={form.articleId} onChange={(e) => update('articleId', e.target.value)}>
            <option value="">Select article</option>
            {store.articles.map((a) => <option key={a.id} value={a.id}>{a.articleName} · {a.articleCode} · Available {articleAvailableQty(a.id)}</option>)}
          </select>
        </Field>
        {selected && <div className="article-mini wide"><b>{selected.articleName}</b><span>{selected.articleType} · {selected.category} / {selected.subcategory || '-'} · Replacement {money(selected.replacementCost)}</span><Badge tone={available > 0 ? 'green' : 'red'}>{available} available</Badge></div>}
        <Field label="Quantity" required><input type="number" min="1" value={form.quantity} onChange={(e) => update('quantity', e.target.value)} /></Field>
        <Field label="Customer Type"><select value={form.customerType} onChange={(e) => update('customerType', e.target.value)}>{customerTypes.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Customer / Contractor Name" required><input value={form.customerName} onChange={(e) => update('customerName', e.target.value)} placeholder="Bablu Contractor" /></Field>
        <Field label="Mobile" required><input inputMode="numeric" value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10 digit phone" /></Field>
        <Field label="Alternate Mobile"><input inputMode="numeric" value={form.alternateMobile} onChange={(e) => update('alternateMobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
        <Field label="Address"><input value={form.address} onChange={(e) => update('address', e.target.value)} placeholder="Customer/site address" /></Field>
        <Field label="Site Name" required><input value={form.siteName} onChange={(e) => update('siteName', e.target.value)} placeholder="Dr Sahi Wardrobe Work" /></Field>
        <Field label="Linked Client"><input value={form.linkedClient} onChange={(e) => update('linkedClient', e.target.value)} placeholder="Client name if different" /></Field>
        <Field label="Purpose of Use"><input value={form.purpose} onChange={(e) => update('purpose', e.target.value)} placeholder="Wardrobe drilling / client sample selection" /></Field>
        <Field label="Issue Date"><input type="date" value={form.issueDate} onChange={(e) => update('issueDate', e.target.value)} /></Field>
        <Field label="Expected Return Date" required><input type="date" value={form.expectedReturnDate} onChange={(e) => update('expectedReturnDate', e.target.value)} /></Field>
        <Field label="Rent Rate"><input type="number" value={form.rentRate} onChange={(e) => update('rentRate', e.target.value)} /></Field>
        <Field label="Rent Unit"><select value={form.rentUnit} onChange={(e) => update('rentUnit', e.target.value)}>{rentUnits.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Deposit Collected"><input type="number" value={form.deposit} onChange={(e) => update('deposit', e.target.value)} /></Field>
        <Field label="Advance Rent"><input type="number" value={form.advancePaid} onChange={(e) => update('advancePaid', e.target.value)} /></Field>
        <Field label="Delivery Charge"><input type="number" value={form.deliveryCharge} onChange={(e) => update('deliveryCharge', e.target.value)} /></Field>
        <Field label="Payment Mode"><select value={form.paymentMode} onChange={(e) => update('paymentMode', e.target.value)}>{paymentModes.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Issued By"><input value={form.issuedBy} onChange={(e) => update('issuedBy', e.target.value)} placeholder="Owner / staff name" /></Field>
        <Field label="Condition Before Issue"><select value={form.conditionBefore} onChange={(e) => update('conditionBefore', e.target.value)}>{conditionOptions.map(x => <option key={x}>{x}</option>)}</select></Field>
        <FileInput label="ID Proof Photo" onFile={(file) => update('idProof', file)} accept="image/*,.pdf" drive={drive} />
        <FileInput label="Before Photo / Video Proof" onFile={addBeforePhoto} accept="image/*,video/*" drive={drive} />
        <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Special instruction / customer commitment" /></Field>

        {selected && <div className="wide subpanel">
          <h3>{selected.articleType === 'Interior Sample / Catalogue' ? 'Sample / Catalogue Issue Checklist' : 'Tool Issue Checklist'}</h3>
          <Checklist items={beforeItems} value={form.checklist} onChange={(v) => update('checklist', v)} />
        </div>}

        {form.accessoriesIssued.length > 0 && <div className="wide subpanel">
          <h3>Accessories / Sample Pieces Issued</h3>
          <div className="checklist cols-3">
            {form.accessoriesIssued.map((x, i) => <label key={x.name + i} className="check-row"><input type="checkbox" checked={x.issued} onChange={(e) => setAccessory(i, e.target.checked)} /><span>{x.name}</span></label>)}
          </div>
        </div>}

        <label className="terms wide"><input type="checkbox" checked={form.termsAccepted} onChange={(e) => update('termsAccepted', e.target.checked)} /> <span>Late return, damage, missing accessory/sample, or lost article charge explained and accepted.</span></label>
        <div className="form-actions wide"><button type="submit">Issue Article + Print Slip</button></div>
      </form>
    </Section>
  );
}

function RentalCard({ rental, onReturn, onDetails }) {
  const msg = encodeURIComponent(`Reminder: ${rental.articleSnapshot} issued to you for ${rental.siteName} is due on ${fmtDate(rental.expectedReturnDate)}. Please return or update status.`);
  const wa = rental.mobile ? `https://wa.me/91${rental.mobile}?text=${msg}` : '#';
  return (
    <div className={`rental-card rental-${rental.computedStatus === 'Overdue' ? 'overdue' : rental.computedStatus === 'Returned' ? 'returned' : 'active'}`}>
      <div className="rental-card-head">
        <div><b>{rental.articleSnapshot}</b><small>{rental.issueNo} · Qty {rental.outstanding}</small></div>
        <Badge tone={rental.computedStatus === 'Overdue' ? 'red' : rental.computedStatus === 'Returned' ? 'green' : 'blue'}>{rental.computedStatus}</Badge>
      </div>
      <div className="rental-meta">
        <span>{rental.customerName}</span><span>{rental.customerType}</span><span>{rental.siteName}</span><span>Due {fmtDate(rental.expectedReturnDate)}</span>
        {rental.overdueDays > 0 && <span className="danger-text">Late by {rental.overdueDays} day(s)</span>}
      </div>
      <div className="row-actions">
        {onDetails && <button className="ghost" onClick={onDetails}>View Details</button>}
        {rental.mobile && <a className="btn ghost" href={wa} target="_blank" rel="noreferrer">WhatsApp Reminder</a>}
        {rental.outstanding > 0 && <button onClick={onReturn}>Return</button>}
      </div>
    </div>
  );
}

function ActiveRentals({ rentals, store, setTab, setReturnRentalId }) {
  const [filter, setFilter] = useState('All');
  const [detailId, setDetailId] = useState('');
  const rows = rentals.filter((r) => r.outstanding > 0).filter((r) => filter === 'All' || r.computedStatus === filter || r.customerType === filter);
  const selectedDetail = rows.find((r) => r.id === detailId) || rentals.find((r) => r.id === detailId);
  const openReturn = (id) => { setReturnRentalId(id); setTab('return'); };
  return (
    <Section title="Active Rentals" subtitle="Card-first daily view with full record detail, WhatsApp reminder and return action." right={<select className="search" value={filter} onChange={(e) => setFilter(e.target.value)}><option>All</option><option>Overdue</option><option>Active</option><option>Contractor</option><option>Client</option><option>Staff</option></select>}>
      <div className="cards-list">
        {rows.map((r) => <RentalCard key={r.id} rental={r} onDetails={() => setDetailId(r.id)} onReturn={() => openReturn(r.id)} />)}
        {rows.length === 0 && <Empty text="No active rentals." />}
      </div>
      <div className="table-wrap compact">
        <table>
          <thead><tr><th>Issue</th><th>Article</th><th>Issued To</th><th>Site</th><th>Due</th><th>Rent</th><th>Deposit</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.issueNo}</td><td>{r.articleSnapshot}<small>{store.articles.find(a => a.id === r.articleId)?.articleCode}</small></td><td>{r.customerName}<small>{r.mobile}</small></td><td>{r.siteName}</td><td>{fmtDate(r.expectedReturnDate)}</td><td>{money(r.rentRate)} / {r.rentUnit}</td><td>{money(r.deposit)}</td><td><Badge tone={r.computedStatus === 'Overdue' ? 'red' : 'blue'}>{r.computedStatus}</Badge></td><td><button className="ghost" onClick={() => setDetailId(r.id)}>Details</button></td></tr>)}</tbody>
        </table>
      </div>
      {selectedDetail && <RentalDetailPanel rental={selectedDetail} store={store} onClose={() => setDetailId('')} onReturn={() => openReturn(selectedDetail.id)} />}
    </Section>
  );
}

function ReturnArticle({ store, saveStore, notify, enrichedRentals, returnRentalId, setReturnRentalId, drive }) {
  const active = enrichedRentals.filter((r) => r.outstanding > 0);
  const selected = enrichedRentals.find((r) => r.id === returnRentalId) || active[0];
  const article = selected ? store.articles.find((a) => a.id === selected.articleId) : null;
  const [form, setForm] = useState({ returnDate: todayISO(), quantityReturned: 1, conditionAfter: 'Good', checklist: Object.fromEntries(CHECKLISTS.returnCheck.map((x) => [x, false])), accessoriesReturned: [], damageDescription: '', missingQuantity: 0, latePenalty: 0, damageDeduction: 0, repairRequired: false, cleaningRequired: false, finalRent: 0, balanceCollected: 0, depositRefund: 0, paymentMode: 'Cash', receivedBy: 'Owner', afterPhotos: [], notes: '', closeMissingAsLost: false });

  useEffect(() => {
    if (!selected) return;
    const days = daysBetween(selected.issueDate, todayISO());
    const rent = toNumber(selected.rentRate) * days * selected.outstanding;
    const late = selected.overdueDays > 0 ? selected.overdueDays * Math.max(50, Math.round(toNumber(selected.rentRate) * 0.5)) : 0;
    setForm((f) => ({
      ...f,
      returnDate: todayISO(),
      quantityReturned: selected.outstanding,
      missingQuantity: 0,
      latePenalty: late,
      finalRent: rent + toNumber(selected.deliveryCharge),
      balanceCollected: Math.max(0, rent + toNumber(selected.deliveryCharge) + late - toNumber(selected.advancePaid)),
      depositRefund: Math.max(0, toNumber(selected.deposit)),
      accessoriesReturned: (selected.accessoriesIssued || []).filter((x) => x.issued).map((x) => ({ ...x, returned: true }))
    }));
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    const rentAndLate = toNumber(form.finalRent) + toNumber(form.latePenalty);
    const damage = toNumber(form.damageDeduction);
    const depositHeld = toNumber(selected.deposit);
    const damageFromDeposit = Math.min(depositHeld, damage);
    const extraDamagePayable = Math.max(0, damage - depositHeld);
    const alreadyPaid = toNumber(selected.advancePaid);
    const payable = Math.max(0, rentAndLate + extraDamagePayable - alreadyPaid);
    const depositRefund = Math.max(0, depositHeld - damageFromDeposit);
    setForm((f) => ({ ...f, balanceCollected: payable, depositRefund, damageFromDeposit, extraDamagePayable }));
  }, [form.finalRent, form.latePenalty, form.damageDeduction, selected?.id]);

  if (!selected) return <Section title="Return Article"><Empty text="No active rental available for return." /></Section>;

  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  async function addPhoto(file) { if (file) setForm((f) => ({ ...f, afterPhotos: [...(f.afterPhotos || []), file] })); }
  function setAccessory(index, value) { setForm((f) => ({ ...f, accessoriesReturned: f.accessoriesReturned.map((a, i) => i === index ? { ...a, returned: value } : a) })); }

  function submit(e) {
    e.preventDefault();
    const qty = Math.min(toNumber(form.quantityReturned), selected.outstanding);
    if (qty <= 0) return notify('Returned quantity must be greater than zero');
    const missing = Math.max(0, selected.outstanding - qty);
    if (missing > 0 && !form.closeMissingAsLost) return notify('Partial return saved only after you confirm missing/lost handling');

    const ret = {
      id: uid('RET'), rentalId: selected.id, articleId: selected.articleId, returnDate: form.returnDate, quantityReturned: qty, conditionAfter: form.conditionAfter,
      checklist: form.checklist, accessoriesReturned: form.accessoriesReturned, damageDescription: form.damageDescription, missingQuantity: missing,
      latePenalty: toNumber(form.latePenalty), damageDeduction: toNumber(form.damageDeduction), repairRequired: form.repairRequired, cleaningRequired: form.cleaningRequired,
      finalRent: toNumber(form.finalRent), balanceCollected: toNumber(form.balanceCollected), depositRefund: toNumber(form.depositRefund), paymentMode: form.paymentMode,
      receivedBy: form.receivedBy, afterPhotos: form.afterPhotos, notes: form.notes, closeMissingAsLost: form.closeMissingAsLost, createdAt: new Date().toISOString()
    };

    const payments = [];
    const damageFromDeposit = Math.min(toNumber(selected.deposit), ret.damageDeduction);
    const extraDamagePayable = Math.max(0, ret.damageDeduction - toNumber(selected.deposit));
    if (ret.balanceCollected > 0) payments.push({ id: uid('PAY'), rentalId: selected.id, articleId: selected.articleId, type: 'Final Rent / Late / Extra Damage', amount: ret.balanceCollected, mode: ret.paymentMode, date: ret.returnDate, receivedBy: ret.receivedBy, notes: `Cash collected during return. Includes rent/late charges${extraDamagePayable ? ` and extra damage ${money(extraDamagePayable)} beyond deposit` : ''}.` });
    if (damageFromDeposit > 0) payments.push({ id: uid('PAY'), rentalId: selected.id, articleId: selected.articleId, type: 'Damage Deducted From Deposit', amount: damageFromDeposit, mode: 'Deposit Adjustment', date: ret.returnDate, receivedBy: ret.receivedBy, notes: ret.damageDescription || 'Damage adjusted against security deposit' });
    if (ret.depositRefund > 0) payments.push({ id: uid('PAY'), rentalId: selected.id, articleId: selected.articleId, type: 'Deposit Refund', amount: ret.depositRefund, mode: ret.paymentMode, date: ret.returnDate, receivedBy: ret.receivedBy, notes: 'Refunded after damage/missing deduction' });

    saveStore((prev) => {
      const rentalAfterQty = toNumber(selected.quantityReturned) + qty + (form.closeMissingAsLost ? missing : 0);
      const nextRentalStatus = rentalAfterQty >= toNumber(selected.quantity) ? 'Closed' : 'Active';
      let nextStatus = 'Available';
      if (form.closeMissingAsLost && missing > 0) nextStatus = 'Lost';
      else if (form.repairRequired) nextStatus = 'In Repair';
      else if (['Damaged', 'Lost'].includes(form.conditionAfter)) nextStatus = form.conditionAfter;
      return {
        ...prev,
        rentals: prev.rentals.map((r) => r.id === selected.id ? { ...r, quantityReturned: rentalAfterQty, status: nextRentalStatus } : r),
        returns: [ret, ...prev.returns],
        payments: [...payments, ...prev.payments],
        articles: prev.articles.map((a) => a.id === selected.articleId ? { ...a, status: nextStatus, condition: form.conditionAfter } : a)
      };
    });
    notify('Return recorded');
    setReturnRentalId('');
    setForm({ returnDate: todayISO(), quantityReturned: 1, conditionAfter: 'Good', checklist: Object.fromEntries(CHECKLISTS.returnCheck.map((x) => [x, false])), accessoriesReturned: [], damageDescription: '', missingQuantity: 0, latePenalty: 0, damageDeduction: 0, repairRequired: false, cleaningRequired: false, finalRent: 0, balanceCollected: 0, depositRefund: 0, paymentMode: 'Cash', receivedBy: 'Owner', afterPhotos: [], notes: '', closeMissingAsLost: false });
  }

  return (
    <Section title="Return Article" subtitle="Guided flow: choose active rental, inspect condition, calculate penalties, refund deposit and close stock.">
      <WorkflowSteps steps={["Select Rental", "Inspect", "Penalty/Deduction", "Payment/Refund", "Close"]} current={selected ? (form.conditionAfter ? (form.balanceCollected || form.depositRefund || form.damageDeduction || form.latePenalty ? 4 : 2) : 1) : 1} />
      <form className="form-grid" onSubmit={submit}>
        <Field label="Active Rental"><select value={selected.id} onChange={(e) => setReturnRentalId(e.target.value)}>{active.map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.articleSnapshot} · {r.customerName} · Out {r.outstanding}</option>)}</select></Field>
        <div className="article-mini wide"><b>{selected.articleSnapshot}</b><span>{selected.customerName} · {selected.siteName} · Due {fmtDate(selected.expectedReturnDate)} · Out Qty {selected.outstanding}</span><Badge tone={selected.overdueDays > 0 ? 'red' : 'blue'}>{selected.overdueDays > 0 ? `${selected.overdueDays} day late` : 'On track'}</Badge></div>
        <Field label="Return Date"><input type="date" value={form.returnDate} onChange={(e) => update('returnDate', e.target.value)} /></Field>
        <Field label="Returned Quantity"><input type="number" min="1" max={selected.outstanding} value={form.quantityReturned} onChange={(e) => update('quantityReturned', e.target.value)} /></Field>
        <Field label="Condition After"><select value={form.conditionAfter} onChange={(e) => update('conditionAfter', e.target.value)}>{conditionOptions.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Final Rent"><input type="number" value={form.finalRent} onChange={(e) => update('finalRent', e.target.value)} /></Field>
        <Field label="Late Penalty"><input type="number" value={form.latePenalty} onChange={(e) => update('latePenalty', e.target.value)} /></Field>
        <Field label="Damage / Missing Deduction"><input type="number" value={form.damageDeduction} onChange={(e) => update('damageDeduction', e.target.value)} /></Field>
        <div className="article-mini"><b>Deposit Adjustment</b><span>Deduct from deposit: {money(form.damageFromDeposit || 0)} · Extra damage payable: {money(form.extraDamagePayable || 0)}</span></div>
        <Field label="Balance Collected"><input type="number" value={form.balanceCollected} onChange={(e) => update('balanceCollected', e.target.value)} /></Field>
        <Field label="Deposit Refund"><input type="number" value={form.depositRefund} onChange={(e) => update('depositRefund', e.target.value)} /></Field>
        <Field label="Payment Mode"><select value={form.paymentMode} onChange={(e) => update('paymentMode', e.target.value)}>{paymentModes.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Received By"><input value={form.receivedBy} onChange={(e) => update('receivedBy', e.target.value)} /></Field>
        <FileInput label="After Return Photo / Video" onFile={addPhoto} accept="image/*,video/*" drive={drive} />
        <Field label="Damage / Missing Details"><textarea value={form.damageDescription} onChange={(e) => update('damageDescription', e.target.value)} placeholder="Wire cut / chuck key missing / page missing" /></Field>
        <Field label="Return Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>

        <div className="wide subpanel"><h3>Return Checklist</h3><Checklist items={CHECKLISTS.returnCheck} value={form.checklist} onChange={(v) => update('checklist', v)} /></div>
        {form.accessoriesReturned.length > 0 && <div className="wide subpanel"><h3>Accessories / Sample Pieces Returned</h3><div className="checklist cols-3">{form.accessoriesReturned.map((x, i) => <label key={x.name + i} className="check-row"><input type="checkbox" checked={x.returned} onChange={(e) => setAccessory(i, e.target.checked)} /><span>{x.name}</span></label>)}</div></div>}
        <label className="terms"><input type="checkbox" checked={form.repairRequired} onChange={(e) => update('repairRequired', e.target.checked)} /> <span>Repair required</span></label>
        <label className="terms"><input type="checkbox" checked={form.cleaningRequired} onChange={(e) => update('cleaningRequired', e.target.checked)} /> <span>Cleaning required</span></label>
        <label className="terms wide"><input type="checkbox" checked={form.closeMissingAsLost} onChange={(e) => update('closeMissingAsLost', e.target.checked)} /> <span>If returned quantity is short, close missing quantity as lost/missing and charge deduction.</span></label>
        <div className="form-actions wide"><button type="submit">Record Return</button></div>
      </form>
    </Section>
  );
}




function Article360({ store, selectedArticleId, setSelectedArticleId, setTab, setReturnRentalId, setEditingArticle }) {
  const [search, setSearch] = useState('');
  const articles = store.articles || [];
  const article = articles.find((a) => a.id === selectedArticleId) || articles[0];
  useEffect(() => {
    if (!selectedArticleId && articles[0]?.id) setSelectedArticleId(articles[0].id);
  }, [selectedArticleId, articles, setSelectedArticleId]);
  const data = useMemo(() => buildArticle360Data(store, article), [store, article]);
  const filteredArticles = articles.filter((a) => `${a.articleName} ${a.articleCode} ${a.category} ${a.subcategory} ${a.brand} ${a.status}`.toLowerCase().includes(search.toLowerCase()));
  const groupedMedia = groupBy(data.media, (m) => m.area);

  if (!articles.length) {
    return (
      <Section title="Article 360 / Article Trace" subtitle="Add an article first, then this page will show full lifecycle, custody, media, repair, and profitability.">
        <div className="empty-state-actions"><Empty text="No article records yet." /><button onClick={() => setTab('articles')}>Add Article</button></div>
      </Section>
    );
  }

  return (
    <div className="customer360-layout article360-layout">
      <aside className="customer360-list">
        <div className="customer360-search">
          <h2>Article 360</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search article, code, category" />
        </div>
        <div className="customer360-party-list">
          {filteredArticles.map((a) => (
            <button key={a.id} className={article?.id === a.id ? 'active' : ''} onClick={() => setSelectedArticleId(a.id)}>
              <b>{a.articleName}</b>
              <span>{a.articleCode} · {a.articleType}</span>
              <small>{a.status} · {a.category}{a.subcategory ? ` / ${a.subcategory}` : ''}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className="customer360-main">
        <section className="customer360-hero">
          <div>
            <Badge tone={data.risk.tone}>{data.risk.label}</Badge>
            <h2>{article?.articleName}</h2>
            <p>{article?.articleCode} · {article?.articleType} · {article?.brand || 'No brand'} · {article?.category}{article?.subcategory ? ` / ${article.subcategory}` : ''}</p>
            <div className="row-actions hero-actions-inline">
              <button className="ghost" onClick={() => { setEditingArticle?.(article); setTab('articles'); }}>Edit Article</button>
              <button className="ghost" onClick={() => setTab('issue')}>Issue Article</button>
              <button className="ghost" onClick={() => setTab('repair')}>Add Repair</button>
            </div>
          </div>
          <div className="trust-score-card">
            <span>Trace Score</span>
            <b>{data.risk.score}/100</b>
            <small>{data.risk.reasons.length ? data.risk.reasons.join(' · ') : 'Clean article history'}</small>
          </div>
        </section>

        <div className="customer360-stats">
          <StatCard label="Total Rentals" value={data.totals.utilizationCount || 0} hint={`${data.activeRentals.length} active custody`} tone="blue" />
          <StatCard label="Rent Earned" value={money(data.totals.rentEarned)} hint={`Deposits held ${money(Math.max(0, data.totals.depositCollected - data.totals.depositRefunded))}`} tone="green" />
          <StatCard label="Repair / Expense" value={money(data.totals.repairCost + data.totals.expenseTotal)} hint={`Recovered ${money(data.totals.damageRecovered)}`} tone={data.totals.repairCost || data.totals.expenseTotal ? 'orange' : 'green'} />
          <StatCard label="Net Profit" value={money(data.totals.netProfit)} hint={`Purchase cost ${money(data.totals.purchaseCost)}`} tone={data.totals.netProfit >= 0 ? 'green' : 'red'} />
        </div>

        <Section title="Article Identity" subtitle="Permanent article master, purchase and stock information.">
          <div className="customer-profile-grid">
            <div><span>Current Status</span><b>{article.status}</b></div>
            <div><span>Current Condition</span><b>{article.condition || '-'}</b></div>
            <div><span>Total Quantity</span><b>{article.qtyTotal}</b></div>
            <div><span>Current Location</span><b>{article.currentLocation || '-'}</b></div>
            <div><span>Serial / Model</span><b>{article.serialNumber || '-'} / {article.modelSize || '-'}</b></div>
            <div><span>Rent / Deposit</span><b>{money(article.rentRate)} / {article.rentUnit} · {money(article.depositDefault)}</b></div>
            <div><span>Purchase</span><b>{fmtDate(article.purchaseDate)} · {money(article.purchaseCost)}</b></div>
            <div><span>Replacement Cost</span><b>{money(article.replacementCost)}</b></div>
            <div className="wide-card"><span>Accessories / Sample Pieces</span><b>{(article.accessories || []).join(', ') || '-'}</b></div>
            <div className="wide-card"><span>Notes</span><b>{article.notes || '-'}</b></div>
          </div>
        </Section>

        <Section title="Current Custody" subtitle="Where the article is right now, who has it, and whether return is overdue.">
          <div className="customer-history-list">
            {data.currentCustody.map(({ rental, outstanding, lateDays, movement }) => (
              <div className="history-card" key={rental.id}>
                <div className="history-head">
                  <div><b>{rental.issueNo} · {rental.customerName}</b><small>{rental.siteName || rental.address || '-'} · Issued {fmtDate(rental.issueDate)} · Due {fmtDate(rental.expectedReturnDate)}</small></div>
                  <Badge tone={lateDays > 0 ? 'red' : 'blue'}>{lateDays > 0 ? `${lateDays} day(s) overdue` : 'With customer'}</Badge>
                </div>
                <div className="history-grid">
                  <span>Outstanding <b>{outstanding}</b></span>
                  <span>Mobile <b>{rental.mobile || '-'}</b></span>
                  <span>Deposit <b>{money(rental.deposit)}</b></span>
                  <span>Movement <b>{movement?.status || 'Not scheduled'}</b></span>
                </div>
                <div className="row-actions">
                  {rental.mobile && <a className="btn ghost" href={waLink(rental.mobile, `Reminder: ${article.articleName} (${article.articleCode}) is due for return.`)} target="_blank" rel="noreferrer">WhatsApp</a>}
                  <button className="ghost" onClick={() => { setReturnRentalId?.(rental.id); setTab('return'); }}>Return</button>
                </div>
              </div>
            ))}
            {data.currentCustody.length === 0 && <Empty text="This article is not currently issued outside." />}
          </div>
        </Section>

        <Section title="Rental Timeline" subtitle="Complete article-wise issue and return trail.">
          <div className="customer-history-list">
            {data.rentals.map((r) => {
              const ret = data.returnsByRental[r.id];
              const late = !rentalClosed(r) ? overdueDays(r.expectedReturnDate) : 0;
              return (
                <div className="history-card" key={r.id}>
                  <div className="history-head">
                    <div><b>{r.issueNo} · {r.customerName}</b><small>{r.siteName || '-'} · Issued by {r.issuedBy || '-'} · {fmtDate(r.issueDate)} → {ret ? fmtDate(ret.returnDate) : fmtDate(r.expectedReturnDate)}</small></div>
                    <Badge tone={rentalClosed(r) ? 'green' : late ? 'red' : 'blue'}>{rentalClosed(r) ? 'Returned' : late ? 'Overdue' : 'Active'}</Badge>
                  </div>
                  <div className="history-grid">
                    <span>Qty <b>{toNumber(r.quantity)} / returned {toNumber(r.quantityReturned)}</b></span>
                    <span>Rent <b>{money(r.rentRate)} / {r.rentUnit}</b></span>
                    <span>Deposit <b>{money(r.deposit)}</b></span>
                    <span>Condition <b>{r.conditionBefore || '-'} → {ret?.conditionAfter || '-'}</b></span>
                  </div>
                  <div className="row-actions">
                    {(r.beforePhotos || []).map((f, i) => <FileLink key={i} file={f} label={`Before ${i + 1}`} />)}
                    {(ret?.afterPhotos || []).map((f, i) => <FileLink key={i} file={f} label={`After ${i + 1}`} />)}
                    {!rentalClosed(r) && <button className="ghost" onClick={() => { setReturnRentalId?.(r.id); setTab('return'); }}>Return</button>}
                  </div>
                </div>
              );
            })}
            {data.rentals.length === 0 && <Empty text="No rental movements for this article yet." />}
          </div>
        </Section>

        <Section title="Media Gallery" subtitle="Article purchase bill, article photo, before/after proof, and repair bills from Google Drive/local fallback.">
          <div className="media-gallery">
            {groupedMedia.map(([area, items]) => (
              <div className="media-group" key={area}>
                <h3>{area}</h3>
                <div className="media-grid">
                  {items.map((m) => (
                    <div className="media-card" key={m.id}>
                      <b>{m.owner}</b>
                      <small>{fmtDate(m.date)}</small>
                      {m.text ? <p className="proof-text-media">{m.text}</p> : <FileLink file={m.file} label="Open media" />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.media.length === 0 && <Empty text="No media/proof linked to this article yet." />}
          </div>
        </Section>

        <div className="two-col">
          <Section title="Repair / Damage History" subtitle="Use this to decide repair, replacement, or retirement.">
            <div className="report-lines">
              {data.repairs.map((rep) => <ReportLine key={rep.id} title={`${rep.issueType || 'Repair'} · ${rep.mechanicVendor || '-'}`} meta={`${fmtDate(rep.repairDate)} · ${rep.reason || rep.notes || '-'}`} value={`${money(rep.repairCost)} / Rec ${money(rep.costRecovered)}`} danger={toNumber(rep.repairCost) > toNumber(rep.costRecovered)} />)}
              {data.returns.filter((ret) => toNumber(ret.damageDeduction) > 0 || ret.damageDescription || ret.conditionAfter === 'Damaged' || ret.conditionAfter === 'Lost').map((ret) => <ReportLine key={`ret-${ret.id}`} title={`${ret.conditionAfter || 'Return issue'} · ${store.rentals.find((r) => r.id === ret.rentalId)?.customerName || '-'}`} meta={`${fmtDate(ret.returnDate)} · ${ret.damageDescription || ret.notes || '-'}`} value={money(toNumber(ret.damageDeduction) + toNumber(ret.latePenalty))} danger />)}
              {data.repairs.length + data.returns.filter((ret) => toNumber(ret.damageDeduction) > 0 || ret.damageDescription).length === 0 && <Empty text="No damage or repair history." />}
            </div>
          </Section>

          <Section title="Profitability Ledger" subtitle="Article-wise rent, deposit, repair, expenses and recoveries.">
            <div className="table-wrap customer-ledger-table"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Note</th></tr></thead><tbody>{data.ledger.map((row) => <tr key={row.id}><td>{fmtDate(row.date)}</td><td>{row.type}</td><td>{row.ref}</td><td>{row.debit ? money(row.debit) : '-'}</td><td>{row.credit ? money(row.credit) : '-'}</td><td>{row.note || '-'}</td></tr>)}</tbody></table>{data.ledger.length === 0 && <Empty text="No article ledger entries yet." />}</div>
          </Section>
        </div>

        <div className="two-col">
          <Section title="Purchase / Vendor Links" subtitle="Purchase orders, spare parts and supplier/service records linked to this article.">
            <div className="report-lines">
              {data.purchaseOrders.map((po) => <ReportLine key={po.id} title={`${po.poNo || 'PO'} · ${po.vendorName || '-'}`} meta={`${fmtDate(po.date)} · ${po.item || '-'} · ${po.status}`} value={money(toNumber(po.qty) * toNumber(po.rate))} />)}
              {data.expenses.map((exp) => <ReportLine key={exp.id} title={`${exp.category} · ${exp.paidTo || '-'}`} meta={`${fmtDate(exp.date)} · ${exp.notes || exp.mode || '-'}`} value={money(exp.amount)} danger />)}
              {data.purchaseOrders.length + data.expenses.length === 0 && <Empty text="No purchase or expense linked to this article." />}
            </div>
          </Section>

          <Section title="Quotation / Invoice Links" subtitle="Commercial documents containing this article.">
            <div className="report-lines">
              {data.quotations.map((q) => <ReportLine key={q.id} title={`${q.quoteNo} · ${q.customerName}`} meta={`${fmtDate(q.quoteDate)} · ${q.status}`} value={money(computeDocTotals(q.items || [], q).grandTotal)} />)}
              {data.invoices.map((inv) => <ReportLine key={inv.id} title={`${inv.invoiceNo} · ${inv.customerName}`} meta={`${fmtDate(inv.invoiceDate)} · Balance ${money(invoiceBalance(inv, store.payments || []))}`} value={money(computeDocTotals(inv.items || [], inv).grandTotal)} />)}
              {data.quotations.length + data.invoices.length === 0 && <Empty text="No quotation or invoice contains this article yet." />}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Customer360({ store, selectedCustomerId, setSelectedCustomerId, setTab }) {
  const [search, setSearch] = useState('');
  const customers = store.customers || [];
  const customer = customers.find((c) => c.id === selectedCustomerId) || customers[0];
  useEffect(() => {
    if (!selectedCustomerId && customers[0]?.id) setSelectedCustomerId(customers[0].id);
  }, [selectedCustomerId, customers, setSelectedCustomerId]);
  const data = useMemo(() => buildCustomer360Data(store, customer), [store, customer]);
  const filteredCustomers = customers.filter((c) => `${c.name} ${c.mobile} ${c.type} ${c.city}`.toLowerCase().includes(search.toLowerCase()));
  const activeRentals = data.rentals.filter((r) => !rentalClosed(r));
  const closedRentals = data.rentals.filter((r) => rentalClosed(r));
  const groupedMedia = groupBy(data.media, (m) => m.area);

  if (!customers.length) {
    return (
      <Section title="Customer 360 / Past Records" subtitle="Add a customer first, then this page will show full past history with Google Drive media.">
        <div className="empty-state-actions"><Empty text="No customer records yet." /><button onClick={() => setTab('customers')}>Add Customer</button></div>
      </Section>
    );
  }

  return (
    <div className="customer360-layout">
      <aside className="customer360-list">
        <div className="customer360-search">
          <h2>Customer 360</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, phone, type" />
        </div>
        <div className="customer360-party-list">
          {filteredCustomers.map((c) => (
            <button key={c.id} className={customer?.id === c.id ? 'active' : ''} onClick={() => setSelectedCustomerId(c.id)}>
              <b>{c.name}</b>
              <span>{c.type} · {c.mobile || 'No mobile'}</span>
              <small>{c.city || c.address || 'No location'}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className="customer360-main">
        <section className="customer360-hero">
          <div>
            <Badge tone={data.risk.tone}>{data.risk.label}</Badge>
            <h2>{customer?.name}</h2>
            <p>{customer?.type} · {customer?.mobile || 'No mobile'} · {customer?.city || customer?.address || 'No address'}</p>
            <div className="row-actions hero-actions-inline">
              {customer?.mobile && <a className="btn" href={waLink(customer.mobile, `Hello ${customer.name}, regarding your rental/service record.`)} target="_blank" rel="noreferrer">WhatsApp</a>}
              <button className="ghost" onClick={() => setTab('customers')}>Edit Profile</button>
              <button className="ghost" onClick={() => setTab('issue')}>Issue Article</button>
            </div>
          </div>
          <div className="trust-score-card">
            <span>Trust Score</span>
            <b>{data.risk.score}/100</b>
            <small>{data.risk.reasons.length ? data.risk.reasons.join(' · ') : 'Clean history'}</small>
          </div>
        </section>

        <div className="customer360-stats">
          <StatCard label="Total Rentals" value={data.rentals.length} hint={`${activeRentals.length} active · ${closedRentals.length} closed`} tone="blue" />
          <StatCard label="Overdue" value={data.totals.overdue} hint="Articles needing follow-up" tone={data.totals.overdue ? 'red' : 'green'} />
          <StatCard label="Damage / Missing" value={data.totals.damageCases + data.totals.missingOrLost} hint="Return inspection issues" tone={data.totals.damageCases || data.totals.missingOrLost ? 'orange' : 'green'} />
          <StatCard label="Receivable" value={money(data.totals.balance)} hint={`Paid ${money(data.totals.paid)}`} tone={data.totals.balance ? 'orange' : 'green'} />
        </div>

        <Section title="Profile Snapshot" subtitle="Basic party details visible before issuing new items.">
          <div className="customer-profile-grid">
            <div><span>Contact Person</span><b>{customer.contactPerson || '-'}</b></div>
            <div><span>Alternate Mobile</span><b>{customer.alternateMobile || '-'}</b></div>
            <div><span>GSTIN</span><b>{customer.gstin || '-'}</b></div>
            <div><span>Opening Balance</span><b>{money(customer.openingBalance)}</b></div>
            <div className="wide-card"><span>Address</span><b>{customer.address || '-'}</b></div>
            <div className="wide-card"><span>Notes</span><b>{customer.notes || '-'}</b></div>
          </div>
        </Section>

        <Section title="Rental History" subtitle="All issued articles linked by customer ID, phone number, or customer name.">
          <div className="customer-history-list">
            {data.rentals.map((r) => {
              const ret = data.returnsByRental[r.id];
              const article = data.articleMap[r.articleId];
              const late = !rentalClosed(r) ? overdueDays(r.expectedReturnDate) : 0;
              return (
                <div className="history-card" key={r.id}>
                  <div className="history-head">
                    <div><b>{r.issueNo} · {r.articleSnapshot || article?.articleName || 'Article'}</b><small>{r.siteName || '-'} · Issued {fmtDate(r.issueDate)} · Due {fmtDate(r.expectedReturnDate)}</small></div>
                    <Badge tone={rentalClosed(r) ? 'green' : late ? 'red' : 'blue'}>{rentalClosed(r) ? 'Returned' : late ? `${late} day(s) overdue` : 'Active'}</Badge>
                  </div>
                  <div className="history-grid">
                    <span>Qty <b>{toNumber(r.quantity)} / returned {toNumber(r.quantityReturned)}</b></span>
                    <span>Rent <b>{money(r.rentRate)} / {r.rentUnit}</b></span>
                    <span>Deposit <b>{money(r.deposit)}</b></span>
                    <span>Condition <b>{r.conditionBefore || '-'} → {ret?.conditionAfter || '-'}</b></span>
                  </div>
                  <div className="row-actions">
                    {r.idProof && <FileLink file={r.idProof} label="ID Proof" />}
                    {(r.beforePhotos || []).map((f, i) => <FileLink key={i} file={f} label={`Before ${i + 1}`} />)}
                    {(ret?.afterPhotos || []).map((f, i) => <FileLink key={i} file={f} label={`After ${i + 1}`} />)}
                    {!rentalClosed(r) && <button className="ghost" onClick={() => setTab('return')}>Return</button>}
                  </div>
                </div>
              );
            })}
            {data.rentals.length === 0 && <Empty text="No rental history for this customer yet." />}
          </div>
        </Section>

        <Section title="Media Gallery" subtitle="Google Drive media links grouped by proof type. Local fallback files also appear here.">
          <div className="media-gallery">
            {groupedMedia.map(([area, items]) => (
              <div className="media-group" key={area}>
                <h3>{area}</h3>
                <div className="media-grid">
                  {items.map((m) => (
                    <div className="media-card" key={m.id}>
                      <b>{m.owner}</b>
                      <small>{fmtDate(m.date)} · {m.articleName}</small>
                      {m.text ? <p className="proof-text-media">{m.text}</p> : <FileLink file={m.file} label="Open media" />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.media.length === 0 && <Empty text="No media/proof linked to this customer yet." />}
          </div>
        </Section>

        <div className="two-col">
          <Section title="Billing / Payment Ledger" subtitle="Customer-wise invoice, rent payment, deposit and refund view.">
            <div className="table-wrap customer-ledger-table"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Note</th></tr></thead><tbody>{data.ledger.map((row) => <tr key={row.id}><td>{fmtDate(row.date)}</td><td>{row.type}</td><td>{row.ref}</td><td>{row.debit ? money(row.debit) : '-'}</td><td>{row.credit ? money(row.credit) : '-'}</td><td>{row.note || '-'}</td></tr>)}</tbody></table>{data.ledger.length === 0 && <Empty text="No ledger entries for this customer." />}</div>
          </Section>

          <Section title="Quotations / Invoices" subtitle="Past commercial documents for this customer.">
            <div className="report-lines">
              {data.quotations.map((q) => <ReportLine key={q.id} title={`${q.quoteNo} · ${q.status}`} meta={`${fmtDate(q.quoteDate)} · ${q.siteName || '-'}`} value={money(computeDocTotals(q.items || [], q).grandTotal)} />)}
              {data.invoices.map((inv) => <ReportLine key={inv.id} title={`${inv.invoiceNo} · ${inv.status}`} meta={`${fmtDate(inv.invoiceDate)} · Balance ${money(invoiceBalance(inv, store.payments || []))}`} value={money(computeDocTotals(inv.items || [], inv).grandTotal)} />)}
              {data.quotations.length + data.invoices.length === 0 && <Empty text="No quotation or invoice linked yet." />}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function CustomerMaster({ store, saveStore, notify, onOpen360 }) {
  const blank = { type: 'Client', name: '', contactPerson: '', mobile: '', alternateMobile: '', gstin: '', address: '', city: '', openingBalance: 0, notes: '' };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState('');
  const [q, setQ] = useState('');
  const rows = (store.customers || []).filter((c) => `${c.name} ${c.mobile} ${c.city} ${c.type}`.toLowerCase().includes(q.toLowerCase()));
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function submit(e) {
    e.preventDefault();
    if (!form.name || !form.mobile) return notify('Customer name and mobile are required');
    saveStore((prev) => {
      const record = { ...form, openingBalance: toNumber(form.openingBalance), updatedAt: new Date().toISOString() };
      if (editingId) return { ...prev, customers: (prev.customers || []).map((c) => c.id === editingId ? { ...c, ...record } : c) };
      return { ...prev, customers: [{ ...record, id: uid('CUS'), createdAt: new Date().toISOString() }, ...(prev.customers || [])] };
    });
    setForm(blank);
    setEditingId('');
    notify(editingId ? 'Customer updated' : 'Customer saved');
  }
  function edit(c) {
    setEditingId(c.id);
    setForm({ type: c.type || 'Client', name: c.name || '', contactPerson: c.contactPerson || '', mobile: c.mobile || '', alternateMobile: c.alternateMobile || '', gstin: c.gstin || '', address: c.address || '', city: c.city || '', openingBalance: c.openingBalance || 0, notes: c.notes || '' });
  }
  return (
    <>
      <Section title="Customer / Party Master" subtitle="Clients, contractors, staff, vendors and other parties used in quotation, billing and ledger.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Party Type"><select value={form.type} onChange={(e) => update('type', e.target.value)}>{customerTypes.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Name" required><input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Client / Contractor / Vendor name" /></Field>
          <Field label="Contact Person"><input value={form.contactPerson} onChange={(e) => update('contactPerson', e.target.value)} /></Field>
          <Field label="Mobile" required><input inputMode="numeric" value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
          <Field label="Alternate Mobile"><input inputMode="numeric" value={form.alternateMobile} onChange={(e) => update('alternateMobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
          <Field label="GSTIN"><input value={form.gstin} onChange={(e) => update('gstin', e.target.value.toUpperCase())} /></Field>
          <Field label="City"><input value={form.city} onChange={(e) => update('city', e.target.value)} /></Field>
          <Field label="Opening Balance"><input type="number" value={form.openingBalance} onChange={(e) => update('openingBalance', e.target.value)} /></Field>
          <Field label="Address"><textarea value={form.address} onChange={(e) => update('address', e.target.value)} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">{editingId ? 'Update Party' : 'Save Party'}</button>{editingId && <button type="button" className="ghost" onClick={() => { setEditingId(''); setForm(blank); }}>Cancel Edit</button>}</div>
        </form>
      </Section>
      <Section title="Party Directory" subtitle="Search and reuse parties in estimates, bills and accounting.">
        <Field label="Search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, city, type" /></Field>
        <div className="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Mobile</th><th>GSTIN</th><th>Address</th><th>Opening</th><th>Action</th></tr></thead><tbody>{rows.map((c) => <tr key={c.id}><td><Badge>{c.type}</Badge></td><td>{c.name}<small>{c.contactPerson || '-'}</small></td><td>{c.mobile}<small>{c.alternateMobile || ''}</small></td><td>{c.gstin || '-'}</td><td>{c.city || '-'}<small>{c.address || ''}</small></td><td>{money(c.openingBalance)}</td><td><div className="row-actions"><button className="ghost" onClick={() => edit(c)}>Edit</button><button className="ghost" onClick={() => onOpen360?.(c.id)}>Open 360</button></div></td></tr>)}</tbody></table>{rows.length === 0 && <Empty text="No party records." />}</div>
      </Section>
    </>
  );
}

function documentRowsHtml(items = []) {
  const rows = computeDocTotals(items).items;
  return rows.map((it, idx) => `<tr><td>${idx + 1}</td><td>${escapeHtml(it.articleName || it.description || '-')}</td><td>${escapeHtml(it.lineType || 'Rental')}</td><td class="right">${escapeHtml(it.qty)}</td><td class="right">${escapeHtml(it.duration)} ${escapeHtml(it.rentUnit || '')}</td><td class="right">${money(it.rate)}</td><td class="right">${money(it.discount)}</td><td class="right">${escapeHtml(it.taxPercent || 0)}%</td><td class="right">${money(it.lineTotal)}</td></tr>`).join('');
}

function buildPrintHtml({ title, number, firmName, doc, totals }) {
  return `<h1>${escapeHtml(firmName || 'Rental Services OS')}</h1><h2>${escapeHtml(title)}: ${escapeHtml(number)}</h2><div class="meta"><div><b>Party:</b> ${escapeHtml(doc.customerName || '-')}<br/><b>Mobile:</b> ${escapeHtml(doc.mobile || '-')}<br/><b>Site:</b> ${escapeHtml(doc.siteName || '-')}</div><div><b>Date:</b> ${escapeHtml(fmtDate(doc.quoteDate || doc.invoiceDate))}<br/><b>Valid/Due:</b> ${escapeHtml(fmtDate(doc.validTill || doc.dueDate))}<br/><b>Status:</b> ${escapeHtml(doc.status || '-')}</div></div><table><thead><tr><th>#</th><th>Item</th><th>Type</th><th class="right">Qty</th><th class="right">Duration</th><th class="right">Rate</th><th class="right">Discount</th><th class="right">GST</th><th class="right">Amount</th></tr></thead><tbody>${documentRowsHtml(doc.items || [])}</tbody></table><table class="totals"><tr><td>Subtotal</td><td class="right">${money(totals.subtotal)}</td></tr><tr><td>GST/Tax</td><td class="right">${money(totals.taxTotal)}</td></tr><tr><td>Delivery</td><td class="right">${money(totals.delivery)}</td></tr><tr><td>Pickup</td><td class="right">${money(totals.pickup)}</td></tr><tr><td>Round Off</td><td class="right">${money(totals.roundOff)}</td></tr><tr><th>Total</th><th class="right">${money(totals.grandTotal)}</th></tr><tr><td>Refundable Deposit</td><td class="right">${money(totals.depositTotal)}</td></tr><tr><th>Total with Deposit</th><th class="right">${money(totals.payableWithDeposit)}</th></tr></table><div class="terms"><b>Terms:</b><br/>${escapeHtml(doc.terms || 'Damage, missing parts and late return are chargeable. Deposit is refundable after inspection.')}</div><p class="muted">Generated from Rental Services OS.</p>`;
}

function defaultQuoteForm(settings = {}) {
  return {
    quoteNo: '', status: 'Draft', customerId: '', customerType: 'Client', customerName: '', mobile: '', siteName: '', quoteDate: todayISO(), validTill: addDaysISO(todayISO(), 7), expectedStartDate: todayISO(), deliveryCharge: 0, pickupCharge: 0, roundOff: 0,
    terms: 'Security deposit is refundable after return inspection. Damage, missing parts, late return, transport and repair are chargeable.', notes: '',
    items: [{ articleId: '', articleName: '', description: '', lineType: 'Rental', qty: 1, duration: 1, rentUnit: 'Day', rate: '', discount: 0, taxPercent: settings.defaultGstPercent ?? 18, deposit: 0 }]
  };
}

function QuotationBuilder({ store, saveStore, notify, articleAvailableQty, setTab }) {
  const [form, setForm] = useState(defaultQuoteForm(store.settings));
  const [editingId, setEditingId] = useState('');
  const totals = computeDocTotals(form.items, form);
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function chooseCustomer(id) {
    const c = (store.customers || []).find((x) => x.id === id);
    if (!c) return update('customerId', '');
    setForm((f) => ({ ...f, customerId: c.id, customerType: c.type, customerName: c.name, mobile: c.mobile }));
  }
  function updateItem(index, key, value) {
    setForm((f) => ({ ...f, items: f.items.map((it, i) => {
      if (i !== index) return it;
      if (key === 'articleId') {
        const a = store.articles.find((x) => x.id === value);
        return { ...it, articleId: value, articleName: a?.articleName || '', description: a?.articleName || it.description, rate: a?.rentRate ?? it.rate, rentUnit: a?.rentUnit || it.rentUnit, deposit: a?.depositDefault ?? it.deposit };
      }
      return { ...it, [key]: value };
    }) }));
  }
  function addItem() { setForm((f) => ({ ...f, items: [...f.items, defaultQuoteForm(store.settings).items[0]] })); }
  function removeItem(index) { setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) })); }
  function submit(e) {
    e.preventDefault();
    if (!form.customerName || !form.mobile) return notify('Customer name and mobile are required');
    if (!form.items.some((it) => it.articleName || it.description)) return notify('Add at least one quotation item');
    saveStore((prev) => {
      const quoteNo = form.quoteNo || nextNumber(prev.settings?.quotePrefix || 'QT', prev.quotations || [], 'quoteNo');
      const record = { ...form, quoteNo, items: totals.items, updatedAt: new Date().toISOString() };
      if (editingId) return { ...prev, quotations: (prev.quotations || []).map((q) => q.id === editingId ? { ...q, ...record } : q) };
      return { ...prev, quotations: [{ ...record, id: uid('QUO'), createdAt: new Date().toISOString() }, ...(prev.quotations || [])] };
    });
    setForm(defaultQuoteForm(store.settings)); setEditingId(''); notify(editingId ? 'Quotation updated' : 'Quotation saved');
  }
  function edit(q) { setEditingId(q.id); setForm({ ...defaultQuoteForm(store.settings), ...q, items: q.items?.length ? q.items : defaultQuoteForm(store.settings).items }); }
  function setQuoteStatus(id, status) { saveStore((prev) => ({ ...prev, quotations: (prev.quotations || []).map((q) => q.id === id ? { ...q, status } : q) })); notify(`Quotation marked ${status}`); }
  function createInvoiceFromQuote(q) {
    saveStore((prev) => {
      const invoiceNo = nextNumber(prev.settings?.invoicePrefix || 'INV', prev.invoices || [], 'invoiceNo');
      const invoice = { id: uid('INV'), invoiceNo, quoteId: q.id, status: 'Unpaid', customerId: q.customerId, customerType: q.customerType, customerName: q.customerName, mobile: q.mobile, siteName: q.siteName, invoiceDate: todayISO(), dueDate: addDaysISO(todayISO(), 7), deliveryCharge: q.deliveryCharge, pickupCharge: q.pickupCharge, roundOff: q.roundOff, terms: q.terms, notes: `Created from quotation ${q.quoteNo}`, items: q.items, createdAt: new Date().toISOString() };
      return { ...prev, invoices: [invoice, ...(prev.invoices || [])], quotations: (prev.quotations || []).map((x) => x.id === q.id ? { ...x, status: 'Converted' } : x) };
    });
    notify('Invoice created from quotation');
    setTab?.('invoices');
  }
  function convertToIssue(q) {
    const blocked = [];
    saveStore((prev) => {
      let rentals = [...(prev.rentals || [])];
      for (const item of q.items || []) {
        if (item.lineType !== 'Rental' || !item.articleId) continue;
        const article = prev.articles.find((a) => a.id === item.articleId);
        if (!article) continue;
        const requestedQty = Math.max(1, toNumber(item.qty));
        const currentlyOut = rentals
          .filter((r) => r.articleId === article.id && !rentalClosed(r))
          .reduce((sum, r) => sum + Math.max(0, toNumber(r.quantity) - toNumber(r.quantityReturned)), 0);
        const availableNow = Math.max(0, toNumber(article.qtyTotal) - currentlyOut);
        const issueCheck = canIssueQuantity({ requestedQty, availableQty: availableNow });
        if (!issueCheck.ok) {
          blocked.push(`${article.articleName}: ${issueCheck.reason}`);
          continue;
        }
        rentals = [{
          id: uid('REN'), issueNo: nextNumber(prev.settings?.receiptPrefix || 'ISS', rentals, 'issueNo'), quoteId: q.id, articleId: article.id, articleSnapshot: article.articleName, quantity: requestedQty, quantityReturned: 0,
          customerType: q.customerType || 'Client', customerName: q.customerName, mobile: q.mobile, alternateMobile: '', address: '', siteName: q.siteName, linkedClient: q.customerName, purpose: `Issued from quotation ${q.quoteNo}`, issueDate: q.expectedStartDate || todayISO(), expectedReturnDate: addDaysISO(q.expectedStartDate || todayISO(), toNumber(item.duration)), rentRate: toNumber(item.rate), rentUnit: item.rentUnit || article.rentUnit || 'Day', deposit: toNumber(item.deposit), advancePaid: 0, deliveryCharge: toNumber(q.deliveryCharge), paymentMode: 'Credit', issuedBy: 'Owner', idProof: null, beforePhotos: [], conditionBefore: article.condition || 'Good', checklist: Object.fromEntries((article.articleType === 'Interior Sample / Catalogue' ? CHECKLISTS.sampleBefore : CHECKLISTS.toolBefore).map((x) => [x, false])), accessoriesIssued: (article.accessories || []).map((x) => ({ name: x, issued: true, returned: false })), termsAccepted: false, notes: `Auto-created from ${q.quoteNo}. Complete proof/checklist during physical handover.`, status: 'Active', createdAt: new Date().toISOString()
        }, ...rentals];
      }
      return { ...prev, rentals, quotations: (prev.quotations || []).map((x) => x.id === q.id ? { ...x, status: blocked.length ? 'Part Issued' : 'Issued', issueBlockedNotes: blocked.join('; ') } : x) };
    });
    notify(blocked.length ? `Issued available items. Blocked: ${blocked.join('; ')}` : 'Rental issue records created from quotation');
    setTab?.('active');
  }
  function printQuote(q = form) { const t = computeDocTotals(q.items || [], q); printDocument(`Quotation ${q.quoteNo || ''}`, buildPrintHtml({ title: 'Quotation / Estimate', number: q.quoteNo || 'Draft', firmName: store.settings.firmName, doc: q, totals: t })); }
  return (
    <>
      <Section title="Estimate / Quotation Builder" subtitle="Guided flow: party, rental items, transport, tax/deposit, approval and conversion.">
        <WorkflowSteps steps={["Party", "Items", "Charges", "Terms", "Send/Approve"]} current={form.customerName ? (form.items?.some((it) => it.articleName || it.description) ? (totals.grandTotal > 0 ? 4 : 2) : 1) : 1} />
        <form className="form-grid" onSubmit={submit}>
          <Field label="Existing Party"><select value={form.customerId} onChange={(e) => chooseCustomer(e.target.value)}><option value="">Manual / new customer</option>{(store.customers || []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.mobile}</option>)}</select></Field>
          <Field label="Quote No"><input value={form.quoteNo} onChange={(e) => update('quoteNo', e.target.value.toUpperCase())} placeholder="Auto" /></Field>
          <Field label="Status"><select value={form.status} onChange={(e) => update('status', e.target.value)}>{['Draft', 'Sent', 'Approved', 'Rejected', 'Converted', 'Issued'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Customer Name" required><input value={form.customerName} onChange={(e) => update('customerName', e.target.value)} /></Field>
          <Field label="Mobile" required><input inputMode="numeric" value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
          <Field label="Site / Work Name"><input value={form.siteName} onChange={(e) => update('siteName', e.target.value)} /></Field>
          <Field label="Quote Date"><input type="date" value={form.quoteDate} onChange={(e) => update('quoteDate', e.target.value)} /></Field>
          <Field label="Valid Till"><input type="date" value={form.validTill} onChange={(e) => update('validTill', e.target.value)} /></Field>
          <Field label="Expected Issue Date"><input type="date" value={form.expectedStartDate} onChange={(e) => update('expectedStartDate', e.target.value)} /></Field>
          <div className="wide subpanel"><h3>Quotation Items</h3><div className="table-wrap compact"><table><thead><tr><th>Article / Description</th><th>Type</th><th>Qty</th><th>Duration</th><th>Rate</th><th>Disc.</th><th>GST%</th><th>Deposit</th><th>Total</th><th></th></tr></thead><tbody>{form.items.map((it, idx) => { const row = computeDocTotals([it]).items[0]; return <tr key={idx}><td><select value={it.articleId} onChange={(e) => updateItem(idx, 'articleId', e.target.value)}><option value="">Manual item</option>{store.articles.map((a) => <option key={a.id} value={a.id}>{a.articleName} · Avl {articleAvailableQty(a.id)}</option>)}</select><input value={it.description || it.articleName || ''} onChange={(e) => updateItem(idx, 'description', e.target.value)} placeholder="Description" /></td><td><select value={it.lineType} onChange={(e) => updateItem(idx, 'lineType', e.target.value)}><option>Rental</option><option>Service</option><option>Sale</option><option>Transport</option></select></td><td><input type="number" value={it.qty} onChange={(e) => updateItem(idx, 'qty', e.target.value)} /></td><td><input type="number" value={it.duration} onChange={(e) => updateItem(idx, 'duration', e.target.value)} /><select value={it.rentUnit} onChange={(e) => updateItem(idx, 'rentUnit', e.target.value)}>{rentUnits.map((x) => <option key={x}>{x}</option>)}</select></td><td><input type="number" value={it.rate} onChange={(e) => updateItem(idx, 'rate', e.target.value)} /></td><td><input type="number" value={it.discount} onChange={(e) => updateItem(idx, 'discount', e.target.value)} /></td><td><input type="number" value={it.taxPercent} onChange={(e) => updateItem(idx, 'taxPercent', e.target.value)} /></td><td><input type="number" value={it.deposit} onChange={(e) => updateItem(idx, 'deposit', e.target.value)} /></td><td>{money(row.lineTotal)}<small>Dep {money(row.deposit)}</small></td><td><button type="button" className="danger ghost" onClick={() => removeItem(idx)}>Remove</button></td></tr>; })}</tbody></table></div><button type="button" className="ghost" onClick={addItem}>+ Add Item</button></div>
          <Field label="Delivery Charge"><input type="number" value={form.deliveryCharge} onChange={(e) => update('deliveryCharge', e.target.value)} /></Field>
          <Field label="Pickup Charge"><input type="number" value={form.pickupCharge} onChange={(e) => update('pickupCharge', e.target.value)} /></Field>
          <Field label="Round Off"><input type="number" value={form.roundOff} onChange={(e) => update('roundOff', e.target.value)} /></Field>
          <div className="subpanel"><h3>Totals</h3><p>Subtotal: <b>{money(totals.subtotal)}</b></p><p>GST/Tax: <b>{money(totals.taxTotal)}</b></p><p>Total: <b>{money(totals.grandTotal)}</b></p><p>Deposit: <b>{money(totals.depositTotal)}</b></p><p>Total with Deposit: <b>{money(totals.payableWithDeposit)}</b></p></div>
          <Field label="Terms"><textarea value={form.terms} onChange={(e) => update('terms', e.target.value)} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">{editingId ? 'Update Quotation' : 'Save Quotation'}</button><button type="button" className="ghost" onClick={() => printQuote(form)}>Print / Save PDF</button>{editingId && <button type="button" className="ghost" onClick={() => { setEditingId(''); setForm(defaultQuoteForm(store.settings)); }}>Cancel Edit</button>}</div>
        </form>
      </Section>
      <Section title="Quotation Register" subtitle="Track draft, sent, approved, rejected and converted quotations.">
        <div className="table-wrap"><table><thead><tr><th>No</th><th>Party</th><th>Site</th><th>Date</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>{(store.quotations || []).map((q) => { const t = computeDocTotals(q.items || [], q); return <tr key={q.id}><td>{q.quoteNo}</td><td>{q.customerName}<small>{q.mobile}</small></td><td>{q.siteName || '-'}</td><td>{fmtDate(q.quoteDate)}<small>Valid {fmtDate(q.validTill)}</small></td><td><Badge tone={docStatusTone(q.status)}>{q.status}</Badge></td><td>{money(t.grandTotal)}<small>Deposit {money(t.depositTotal)}</small></td><td className="row-actions"><button className="ghost" onClick={() => edit(q)}>Edit</button><button className="ghost" onClick={() => printQuote(q)}>Print</button><button className="ghost" onClick={() => setQuoteStatus(q.id, 'Sent')}>Sent</button><button className="ghost" onClick={() => setQuoteStatus(q.id, 'Approved')}>Approve</button><button className="ghost" onClick={() => convertToIssue(q)}>Issue</button><button className="ghost" onClick={() => createInvoiceFromQuote(q)}>Invoice</button></td></tr>; })}</tbody></table>{(store.quotations || []).length === 0 && <Empty text="No quotations." />}</div>
      </Section>
    </>
  );
}

function defaultInvoiceForm(settings = {}) {
  return { invoiceNo: '', quoteId: '', rentalId: '', status: 'Unpaid', customerId: '', customerType: 'Client', customerName: '', mobile: '', siteName: '', invoiceDate: todayISO(), dueDate: addDaysISO(todayISO(), 7), deliveryCharge: 0, pickupCharge: 0, roundOff: 0, terms: 'Payment due as per invoice. Deposit refund is subject to return inspection.', notes: '', items: [{ articleId: '', articleName: '', description: '', lineType: 'Rental', qty: 1, duration: 1, rentUnit: 'Day', rate: '', discount: 0, taxPercent: settings.defaultGstPercent ?? 18, deposit: 0 }] };
}

function InvoiceBilling({ store, saveStore, notify }) {
  const [form, setForm] = useState(defaultInvoiceForm(store.settings));
  const [editingId, setEditingId] = useState('');
  const [pay, setPay] = useState({ invoiceId: '', amount: '', mode: 'Cash', date: todayISO(), receivedBy: 'Owner', notes: '' });
  const totals = computeDocTotals(form.items, form);
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function loadQuote(id) {
    const q = (store.quotations || []).find((x) => x.id === id);
    if (!q) return update('quoteId', '');
    setForm((f) => ({ ...f, quoteId: q.id, customerId: q.customerId, customerType: q.customerType, customerName: q.customerName, mobile: q.mobile, siteName: q.siteName, deliveryCharge: q.deliveryCharge, pickupCharge: q.pickupCharge, roundOff: q.roundOff, terms: q.terms, items: q.items || [] }));
  }
  function loadRental(id) {
    const r = (store.rentals || []).find((x) => x.id === id);
    if (!r) return update('rentalId', '');
    setForm((f) => ({ ...f, rentalId: r.id, customerType: r.customerType, customerName: r.customerName, mobile: r.mobile, siteName: r.siteName, deliveryCharge: r.deliveryCharge, items: [{ articleId: r.articleId, articleName: r.articleSnapshot, description: r.articleSnapshot, lineType: 'Rental', qty: r.quantity, duration: daysBetween(r.issueDate, r.expectedReturnDate), rentUnit: r.rentUnit, rate: r.rentRate, discount: 0, taxPercent: store.settings.defaultGstPercent ?? 18, deposit: r.deposit }] }));
  }
  function updateItem(index, key, value) { setForm((f) => ({ ...f, items: f.items.map((it, i) => i === index ? { ...it, [key]: value } : it) })); }
  function addItem() { setForm((f) => ({ ...f, items: [...f.items, defaultInvoiceForm(store.settings).items[0]] })); }
  function removeItem(index) { setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) })); }
  function submit(e) {
    e.preventDefault();
    if (!form.customerName || !form.mobile) return notify('Customer name and mobile are required');
    const existing = editingId ? (store.invoices || []).find((inv) => inv.id === editingId) : null;
    if (existing && shouldLockPaidInvoice(existing, store.payments || [])) {
      notify('Paid/part-paid invoices are locked. Create a reversal/adjustment entry instead of editing the bill.');
      return;
    }
    saveStore((prev) => {
      const invoiceNo = form.invoiceNo || nextNumber(prev.settings?.invoicePrefix || 'INV', prev.invoices || [], 'invoiceNo');
      const record = { ...form, invoiceNo, items: totals.items, updatedAt: new Date().toISOString() };
      if (editingId) return { ...prev, invoices: (prev.invoices || []).map((inv) => inv.id === editingId ? { ...inv, ...record } : inv) };
      return { ...prev, invoices: [{ ...record, id: uid('INV'), createdAt: new Date().toISOString() }, ...(prev.invoices || [])] };
    });
    setForm(defaultInvoiceForm(store.settings)); setEditingId(''); notify(editingId ? 'Invoice updated' : 'Invoice saved');
  }
  function edit(inv) {
    if (shouldLockPaidInvoice(inv, store.payments || [])) return notify('This invoice has payment history and is locked. Use reversal/adjustment instead of editing.');
    setEditingId(inv.id);
    setForm({ ...defaultInvoiceForm(store.settings), ...inv, items: inv.items?.length ? inv.items : defaultInvoiceForm(store.settings).items });
  }
  function recordPayment(e) {
    e.preventDefault();
    const inv = (store.invoices || []).find((x) => x.id === pay.invoiceId);
    if (!inv || !pay.amount) return notify('Select invoice and amount');
    saveStore((prev) => {
      const payment = { id: uid('PAY'), invoiceId: inv.id, rentalId: inv.rentalId || '', articleId: inv.items?.[0]?.articleId || '', type: 'Invoice Payment', amount: toNumber(pay.amount), mode: pay.mode, date: pay.date, receivedBy: pay.receivedBy, notes: pay.notes || `Against invoice ${inv.invoiceNo}`, createdAt: new Date().toISOString() };
      const nextPayments = [payment, ...(prev.payments || [])];
      return { ...prev, payments: nextPayments, invoices: (prev.invoices || []).map((x) => x.id === inv.id ? { ...x, status: invoiceBalance(x, nextPayments) <= 0 ? 'Paid' : 'Part Paid' } : x) };
    });
    setPay({ invoiceId: '', amount: '', mode: 'Cash', date: todayISO(), receivedBy: 'Owner', notes: '' }); notify('Invoice payment recorded');
  }
  function printInvoice(inv = form) { const t = computeDocTotals(inv.items || [], inv); printDocument(`Invoice ${inv.invoiceNo || ''}`, buildPrintHtml({ title: 'Tax Invoice / Bill', number: inv.invoiceNo || 'Draft', firmName: store.settings.firmName, doc: inv, totals: t })); }
  const invoices = store.invoices || [];
  return (
    <>
      <Section title="Billing / Invoice Builder" subtitle="Guided flow: load quotation/rental, verify items, create bill, record payment, track receivable.">
        <WorkflowSteps steps={["Load Source", "Verify Party", "Bill Items", "Save Invoice", "Collect Payment"]} current={form.quoteId || form.rentalId ? (form.customerName ? (totals.grandTotal > 0 ? 4 : 2) : 1) : 1} />
        <form className="form-grid" onSubmit={submit}>
          <Field label="Load Quotation"><select value={form.quoteId} onChange={(e) => loadQuote(e.target.value)}><option value="">None</option>{(store.quotations || []).map((q) => <option key={q.id} value={q.id}>{q.quoteNo} · {q.customerName}</option>)}</select></Field>
          <Field label="Load Rental"><select value={form.rentalId} onChange={(e) => loadRental(e.target.value)}><option value="">None</option>{(store.rentals || []).map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.customerName}</option>)}</select></Field>
          <Field label="Invoice No"><input value={form.invoiceNo} onChange={(e) => update('invoiceNo', e.target.value.toUpperCase())} placeholder="Auto" /></Field>
          <Field label="Status"><select value={form.status} onChange={(e) => update('status', e.target.value)}>{['Unpaid', 'Part Paid', 'Paid', 'Cancelled'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Customer Name"><input value={form.customerName} onChange={(e) => update('customerName', e.target.value)} /></Field>
          <Field label="Mobile"><input inputMode="numeric" value={form.mobile} onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
          <Field label="Site"><input value={form.siteName} onChange={(e) => update('siteName', e.target.value)} /></Field>
          <Field label="Invoice Date"><input type="date" value={form.invoiceDate} onChange={(e) => update('invoiceDate', e.target.value)} /></Field>
          <Field label="Due Date"><input type="date" value={form.dueDate} onChange={(e) => update('dueDate', e.target.value)} /></Field>
          <div className="wide subpanel"><h3>Invoice Items</h3><div className="table-wrap compact"><table><thead><tr><th>Description</th><th>Type</th><th>Qty</th><th>Duration</th><th>Rate</th><th>Disc.</th><th>GST%</th><th>Deposit</th><th>Total</th><th></th></tr></thead><tbody>{form.items.map((it, idx) => { const row = computeDocTotals([it]).items[0]; return <tr key={idx}><td><input value={it.description || it.articleName || ''} onChange={(e) => updateItem(idx, 'description', e.target.value)} /></td><td><select value={it.lineType} onChange={(e) => updateItem(idx, 'lineType', e.target.value)}><option>Rental</option><option>Service</option><option>Sale</option><option>Transport</option><option>Damage</option><option>Late Penalty</option></select></td><td><input type="number" value={it.qty} onChange={(e) => updateItem(idx, 'qty', e.target.value)} /></td><td><input type="number" value={it.duration} onChange={(e) => updateItem(idx, 'duration', e.target.value)} /><select value={it.rentUnit} onChange={(e) => updateItem(idx, 'rentUnit', e.target.value)}>{rentUnits.map((x) => <option key={x}>{x}</option>)}</select></td><td><input type="number" value={it.rate} onChange={(e) => updateItem(idx, 'rate', e.target.value)} /></td><td><input type="number" value={it.discount} onChange={(e) => updateItem(idx, 'discount', e.target.value)} /></td><td><input type="number" value={it.taxPercent} onChange={(e) => updateItem(idx, 'taxPercent', e.target.value)} /></td><td><input type="number" value={it.deposit} onChange={(e) => updateItem(idx, 'deposit', e.target.value)} /></td><td>{money(row.lineTotal)}</td><td><button type="button" className="danger ghost" onClick={() => removeItem(idx)}>Remove</button></td></tr>; })}</tbody></table></div><button type="button" className="ghost" onClick={addItem}>+ Add Item</button></div>
          <Field label="Delivery"><input type="number" value={form.deliveryCharge} onChange={(e) => update('deliveryCharge', e.target.value)} /></Field>
          <Field label="Pickup"><input type="number" value={form.pickupCharge} onChange={(e) => update('pickupCharge', e.target.value)} /></Field>
          <Field label="Round Off"><input type="number" value={form.roundOff} onChange={(e) => update('roundOff', e.target.value)} /></Field>
          <div className="subpanel"><h3>Total</h3><p>Bill Total: <b>{money(totals.grandTotal)}</b></p><p>Refundable Deposit: <b>{money(totals.depositTotal)}</b></p></div>
          <Field label="Terms"><textarea value={form.terms} onChange={(e) => update('terms', e.target.value)} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">{editingId ? 'Update Invoice' : 'Save Invoice'}</button><button type="button" className="ghost" onClick={() => printInvoice(form)}>Print / Save PDF</button>{editingId && <button type="button" className="ghost" onClick={() => { setEditingId(''); setForm(defaultInvoiceForm(store.settings)); }}>Cancel Edit</button>}</div>
        </form>
      </Section>
      <Section title="Invoice Payment" subtitle="Record money received against a specific bill and update invoice status.">
        <form className="form-grid" onSubmit={recordPayment}>
          <Field label="Invoice"><select value={pay.invoiceId} onChange={(e) => setPay((p) => ({ ...p, invoiceId: e.target.value }))}><option value="">Select invoice</option>{invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoiceNo} · {inv.customerName} · Due {money(invoiceBalance(inv, store.payments || []))}</option>)}</select></Field>
          <Field label="Amount"><input type="number" value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} /></Field>
          <Field label="Mode"><select value={pay.mode} onChange={(e) => setPay((p) => ({ ...p, mode: e.target.value }))}>{paymentModes.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={pay.date} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} /></Field>
          <Field label="Received By"><input value={pay.receivedBy} onChange={(e) => setPay((p) => ({ ...p, receivedBy: e.target.value }))} /></Field>
          <Field label="Notes"><textarea value={pay.notes} onChange={(e) => setPay((p) => ({ ...p, notes: e.target.value }))} /></Field>
          <div className="form-actions wide"><button type="submit">Record Invoice Payment</button></div>
        </form>
      </Section>
      <Section title="Invoice Register" subtitle="Outstanding bills, part paid invoices and print actions.">
        <div className="table-wrap"><table><thead><tr><th>No</th><th>Party</th><th>Date</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th><th>Actions</th></tr></thead><tbody>{invoices.map((inv) => { const t = computeDocTotals(inv.items || [], inv); const paid = invoicePaidAmount(inv.id, store.payments || []); const bal = invoiceBalance(inv, store.payments || []); return <tr key={inv.id}><td>{inv.invoiceNo}</td><td>{inv.customerName}<small>{inv.siteName || inv.mobile}</small></td><td>{fmtDate(inv.invoiceDate)}<small>Due {fmtDate(inv.dueDate)}</small></td><td><Badge tone={bal <= 0 ? 'green' : docStatusTone(inv.status)}>{bal <= 0 ? 'Paid' : inv.status}</Badge></td><td>{money(t.grandTotal)}</td><td>{money(paid)}</td><td>{money(bal)}</td><td className="row-actions"><button className="ghost" onClick={() => edit(inv)}>Edit</button><button className="ghost" onClick={() => printInvoice(inv)}>Print</button></td></tr>; })}</tbody></table>{invoices.length === 0 && <Empty text="No invoices." />}</div>
      </Section>
    </>
  );
}

function AccountingPanel({ store, saveStore, notify }) {
  const [expense, setExpense] = useState({ date: todayISO(), category: 'Transport', paidTo: '', amount: '', mode: 'Cash', linkedArticleId: '', linkedRentalId: '', notes: '' });
  function update(key, value) { setExpense((e) => ({ ...e, [key]: value })); }
  function submitExpense(e) {
    e.preventDefault();
    if (!expense.amount || !expense.category) return notify('Expense category and amount are required');
    saveStore((prev) => ({ ...prev, expenses: [{ ...expense, id: uid('EXP'), amount: toNumber(expense.amount), createdAt: new Date().toISOString() }, ...(prev.expenses || [])] }));
    setExpense({ date: todayISO(), category: 'Transport', paidTo: '', amount: '', mode: 'Cash', linkedArticleId: '', linkedRentalId: '', notes: '' }); notify('Expense saved');
  }
  const revenueTypes = ['Rent Payment', 'Advance Rent', 'Invoice Payment', 'Damage Deduction', 'Late Penalty', 'Repair Recovery'];
  const revenue = (store.payments || []).filter((p) => revenueTypes.includes(p.type)).reduce((s, p) => s + toNumber(p.amount), 0);
  const depositCollected = (store.payments || []).filter((p) => p.type === 'Deposit Collected').reduce((s, p) => s + toNumber(p.amount), 0);
  const depositRefunded = (store.payments || []).filter((p) => p.type === 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
  const expensesTotal = (store.expenses || []).reduce((s, e) => s + toNumber(e.amount), 0);
  const repairCost = (store.repairs || []).reduce((s, r) => s + toNumber(r.repairCost), 0);
  const receivable = (store.invoices || []).reduce((s, inv) => s + invoiceBalance(inv, store.payments || []), 0);
  const profit = revenue - expensesTotal - repairCost;
  const daybook = [
    ...(store.payments || []).map((p) => ({ id: p.id, date: p.date, type: p.type, party: p.receivedBy || '-', inflow: p.type === 'Deposit Refund' ? 0 : toNumber(p.amount), outflow: p.type === 'Deposit Refund' ? toNumber(p.amount) : 0, mode: p.mode, notes: p.notes })),
    ...(store.expenses || []).map((e) => ({ id: e.id, date: e.date, type: `Expense: ${e.category}`, party: e.paidTo, inflow: 0, outflow: toNumber(e.amount), mode: e.mode, notes: e.notes }))
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const ledger = (store.invoices || []).map((inv) => ({ invoice: inv, total: computeDocTotals(inv.items || [], inv).grandTotal, paid: invoicePaidAmount(inv.id, store.payments || []), balance: invoiceBalance(inv, store.payments || []) }));
  return (
    <>
      <div className="stats-grid">
        <StatCard label="Revenue" value={money(revenue)} hint="Rent/invoice/damage/late" tone="green" />
        <StatCard label="Expenses" value={money(expensesTotal + repairCost)} hint="Expense + repair cost" tone="red" />
        <StatCard label="Net Profit" value={money(profit)} hint="Before tax/accountant adjustments" tone={profit >= 0 ? 'green' : 'red'} />
        <StatCard label="Receivable" value={money(receivable)} hint="Invoice balance pending" tone="orange" />
        <StatCard label="Deposit Held" value={money(Math.max(0, depositCollected - depositRefunded))} hint="Refundable liability" />
      </div>
      <Section title="Expense Entry" subtitle="Transport, staff salary, repair, purchase, fuel, office and other expense tracking.">
        <form className="form-grid" onSubmit={submitExpense}>
          <Field label="Date"><input type="date" value={expense.date} onChange={(e) => update('date', e.target.value)} /></Field>
          <Field label="Category"><select value={expense.category} onChange={(e) => update('category', e.target.value)}>{['Transport', 'Purchase', 'Repair', 'Staff Salary', 'Fuel', 'Office', 'Rent', 'Marketing', 'Other'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Paid To"><input value={expense.paidTo} onChange={(e) => update('paidTo', e.target.value)} /></Field>
          <Field label="Amount"><input type="number" value={expense.amount} onChange={(e) => update('amount', e.target.value)} /></Field>
          <Field label="Mode"><select value={expense.mode} onChange={(e) => update('mode', e.target.value)}>{paymentModes.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Linked Article"><select value={expense.linkedArticleId} onChange={(e) => update('linkedArticleId', e.target.value)}><option value="">None</option>{store.articles.map((a) => <option key={a.id} value={a.id}>{a.articleName}</option>)}</select></Field>
          <Field label="Linked Rental"><select value={expense.linkedRentalId} onChange={(e) => update('linkedRentalId', e.target.value)}><option value="">None</option>{store.rentals.map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.customerName}</option>)}</select></Field>
          <Field label="Notes"><textarea value={expense.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">Save Expense</button></div>
        </form>
      </Section>
      <Section title="Customer-wise Receivable Ledger" subtitle="Invoice total, paid and balance pending.">
        <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Party</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th></tr></thead><tbody>{ledger.map((row) => <tr key={row.invoice.id}><td>{row.invoice.invoiceNo}</td><td>{row.invoice.customerName}<small>{row.invoice.siteName || row.invoice.mobile}</small></td><td>{fmtDate(row.invoice.invoiceDate)}</td><td>{money(row.total)}</td><td>{money(row.paid)}</td><td>{money(row.balance)}</td></tr>)}</tbody></table>{ledger.length === 0 && <Empty text="No invoice ledger yet." />}</div>
      </Section>
      <Section title="Daybook / Cashbook" subtitle="All collections and expenses in one date-wise view.">
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Party</th><th>Mode</th><th>Inflow</th><th>Outflow</th><th>Notes</th></tr></thead><tbody>{daybook.map((d) => <tr key={d.id}><td>{fmtDate(d.date)}</td><td>{d.type}</td><td>{d.party || '-'}</td><td>{d.mode}</td><td>{money(d.inflow)}</td><td>{money(d.outflow)}</td><td>{d.notes || '-'}</td></tr>)}</tbody></table>{daybook.length === 0 && <Empty text="No daybook entries." />}</div>
      </Section>
      <Section title="Profit & Loss Summary" subtitle="Simple business P&L. Final GST/tax filing should still be verified by your accountant.">
        <div className="notes-grid">
          <div><b>Revenue</b><p>{money(revenue)}</p><small>Rent, invoice payments, damage, late penalty and recovery.</small></div>
          <div><b>Operating Expense</b><p>{money(expensesTotal)}</p><small>Manual expenses entered by you.</small></div>
          <div><b>Repair Expense</b><p>{money(repairCost)}</p><small>Repair & maintenance records.</small></div>
          <div><b>Net Profit</b><p>{money(profit)}</p><small>Revenue minus expenses and repair.</small></div>
        </div>
      </Section>
    </>
  );
}

function RepairMaintenance({ store, saveStore, notify, drive }) {
  const [form, setForm] = useState({ articleId: '', repairDate: todayISO(), issueType: 'Repair', reason: '', repairCost: '', mechanicVendor: '', bill: null, costRecovered: '', recoveredFrom: '', statusAfter: 'Available', notes: '' });
  const repairs = store.repairs.map((r) => ({ ...r, article: store.articles.find((a) => a.id === r.articleId) }));
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function submit(e) {
    e.preventDefault();
    if (!form.articleId || !form.reason) return notify('Article and reason are required');
    const record = { ...form, id: uid('REP'), repairCost: toNumber(form.repairCost), costRecovered: toNumber(form.costRecovered), createdAt: new Date().toISOString() };
    saveStore((prev) => ({ ...prev, repairs: [record, ...prev.repairs], articles: prev.articles.map((a) => a.id === form.articleId ? { ...a, status: form.statusAfter, condition: form.statusAfter === 'Available' ? 'Good' : a.condition } : a) }));
    setForm({ articleId: '', repairDate: todayISO(), issueType: 'Repair', reason: '', repairCost: '', mechanicVendor: '', bill: null, costRecovered: '', recoveredFrom: '', statusAfter: 'Available', notes: '' });
    notify('Repair/maintenance record saved');
  }
  return (
    <>
      <Section title="Repair & Maintenance" subtitle="Track servicing, repair cost, who damaged it and recovery.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Article" required><select value={form.articleId} onChange={(e) => update('articleId', e.target.value)}><option value="">Select article</option>{store.articles.map((a) => <option key={a.id} value={a.id}>{a.articleName} · {a.articleCode}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={form.repairDate} onChange={(e) => update('repairDate', e.target.value)} /></Field>
          <Field label="Type"><select value={form.issueType} onChange={(e) => update('issueType', e.target.value)}><option>Repair</option><option>Routine Service</option><option>Cleaning</option><option>Damage Inspection</option><option>Accessory Replacement</option></select></Field>
          <Field label="Reason" required><input value={form.reason} onChange={(e) => update('reason', e.target.value)} placeholder="Wire cut / missing sample / monthly service" /></Field>
          <Field label="Repair Cost"><input type="number" value={form.repairCost} onChange={(e) => update('repairCost', e.target.value)} /></Field>
          <Field label="Mechanic / Vendor"><input value={form.mechanicVendor} onChange={(e) => update('mechanicVendor', e.target.value)} /></Field>
          <Field label="Cost Recovered"><input type="number" value={form.costRecovered} onChange={(e) => update('costRecovered', e.target.value)} /></Field>
          <Field label="Recovered From"><input value={form.recoveredFrom} onChange={(e) => update('recoveredFrom', e.target.value)} placeholder="Customer/contractor name" /></Field>
          <Field label="Status After"><select value={form.statusAfter} onChange={(e) => update('statusAfter', e.target.value)}>{articleStatus.map(x => <option key={x}>{x}</option>)}</select></Field>
          <FileInput label="Repair Bill Photo/PDF" onFile={(file) => update('bill', file)} drive={drive} />
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">Save Repair Record</button></div>
        </form>
      </Section>
      <Section title="Repair History" subtitle="Use this to identify loss-making articles.">
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Article</th><th>Type</th><th>Reason</th><th>Cost</th><th>Recovered</th><th>Status</th></tr></thead><tbody>{repairs.map((r) => <tr key={r.id}><td>{fmtDate(r.repairDate)}</td><td>{r.article?.articleName || '-'}</td><td>{r.issueType}</td><td>{r.reason}<small>{r.mechanicVendor}</small></td><td>{money(r.repairCost)}</td><td>{money(r.costRecovered)}<small>{r.recoveredFrom}</small></td><td><Badge>{r.statusAfter}</Badge></td></tr>)}</tbody></table>{repairs.length === 0 && <Empty text="No repair records." />}</div>
      </Section>
    </>
  );
}

function Payments({ store, saveStore, notify }) {
  const [form, setForm] = useState({ rentalId: '', invoiceId: '', articleId: '', type: 'Rent Payment', amount: '', mode: 'Cash', date: todayISO(), receivedBy: 'Owner', notes: '' });
  const rentals = store.rentals;
  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function submit(e) {
    e.preventDefault();
    if (!form.amount) return notify('Amount is required');
    const rental = rentals.find((r) => r.id === form.rentalId);
    const payment = { ...form, id: uid('PAY'), articleId: rental?.articleId || form.articleId, amount: toNumber(form.amount), createdAt: new Date().toISOString() };
    saveStore((prev) => {
      const nextPayments = [payment, ...(prev.payments || [])];
      return { ...prev, payments: nextPayments, invoices: (prev.invoices || []).map((inv) => inv.id === form.invoiceId ? { ...inv, status: invoiceBalance(inv, nextPayments) <= 0 ? 'Paid' : 'Part Paid' } : inv) };
    });
    setForm({ rentalId: '', invoiceId: '', articleId: '', type: 'Rent Payment', amount: '', mode: 'Cash', date: todayISO(), receivedBy: 'Owner', notes: '' });
    notify('Payment saved');
  }
  const rows = store.payments.map((p) => ({ ...p, rental: store.rentals.find((r) => r.id === p.rentalId), invoice: (store.invoices || []).find((inv) => inv.id === p.invoiceId), article: store.articles.find((a) => a.id === p.articleId) }));
  return (
    <>
      <Section title="Payment / Deposit Ledger" subtitle="Record rent, advance, security deposit, damage deduction and deposit refund.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Linked Rental"><select value={form.rentalId} onChange={(e) => update('rentalId', e.target.value)}><option value="">Manual / Not linked</option>{rentals.map((r) => <option key={r.id} value={r.id}>{r.issueNo} · {r.articleSnapshot} · {r.customerName}</option>)}</select></Field>
          <Field label="Linked Invoice"><select value={form.invoiceId} onChange={(e) => { update('invoiceId', e.target.value); if (e.target.value) update('type', 'Invoice Payment'); }}><option value="">Not linked</option>{(store.invoices || []).map((inv) => <option key={inv.id} value={inv.id}>{inv.invoiceNo} · {inv.customerName} · Due {money(invoiceBalance(inv, store.payments || []))}</option>)}</select></Field>
          <Field label="Article"><select value={form.articleId} onChange={(e) => update('articleId', e.target.value)}><option value="">Select if not linked</option>{store.articles.map((a) => <option key={a.id} value={a.id}>{a.articleName}</option>)}</select></Field>
          <Field label="Type"><select value={form.type} onChange={(e) => update('type', e.target.value)}><option>Rent Payment</option><option>Invoice Payment</option><option>Advance Rent</option><option>Deposit Collected</option><option>Deposit Refund</option><option>Damage Deduction</option><option>Late Penalty</option><option>Repair Recovery</option></select></Field>
          <Field label="Amount"><input type="number" value={form.amount} onChange={(e) => update('amount', e.target.value)} /></Field>
          <Field label="Mode"><select value={form.mode} onChange={(e) => update('mode', e.target.value)}>{paymentModes.map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={form.date} onChange={(e) => update('date', e.target.value)} /></Field>
          <Field label="Received / Paid By"><input value={form.receivedBy} onChange={(e) => update('receivedBy', e.target.value)} /></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} /></Field>
          <div className="form-actions wide"><button type="submit">Save Payment</button></div>
        </form>
      </Section>
      <Section title="Ledger Entries" subtitle="Positive entries are collections; Deposit Refund is outgoing liability settlement.">
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Mode</th><th>Rental</th><th>Invoice</th><th>Article</th><th>Notes</th></tr></thead><tbody>{rows.map((p) => <tr key={p.id}><td>{fmtDate(p.date)}</td><td><Badge tone={p.type === 'Deposit Refund' ? 'orange' : 'green'}>{p.type}</Badge></td><td>{money(p.amount)}</td><td>{p.mode}</td><td>{p.rental ? `${p.rental.issueNo} · ${p.rental.customerName}` : '-'}</td><td>{p.invoice ? `${p.invoice.invoiceNo} · ${p.invoice.customerName}` : '-'}</td><td>{p.article?.articleName || '-'}</td><td>{p.notes || '-'}</td></tr>)}</tbody></table>{rows.length === 0 && <Empty text="No payments." />}</div>
      </Section>
    </>
  );
}

function Reports({ store, rentals, articleAvailableQty }) {
  const active = rentals.filter((r) => r.outstanding > 0);
  const overdue = active.filter((r) => r.overdueDays > 0);
  const damageReturns = store.returns.filter((r) => toNumber(r.damageDeduction) > 0 || r.damageDescription || r.conditionAfter === 'Damaged');
  const lostArticles = store.articles.filter((a) => a.status === 'Lost');
  const repairTotal = store.repairs.reduce((s, r) => s + toNumber(r.repairCost), 0);

  const customerWise = groupBy(active, (r) => `${r.customerType}: ${r.customerName}`).map(([name, rows]) => ({ name, count: rows.length, qty: rows.reduce((s, r) => s + r.outstanding, 0), deposit: rows.reduce((s, r) => s + toNumber(r.deposit), 0) }));
  const contractorWise = groupBy(active.filter((r) => r.customerType === 'Contractor'), (r) => r.customerName).map(([name, rows]) => ({ name, count: rows.length, qty: rows.reduce((s, r) => s + r.outstanding, 0), sites: [...new Set(rows.map((r) => r.siteName))].join(', ') }));

  const articleProfit = store.articles.map((a) => {
    const pays = store.payments.filter((p) => p.articleId === a.id && p.type !== 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
    const refund = store.payments.filter((p) => p.articleId === a.id && p.type === 'Deposit Refund').reduce((s, p) => s + toNumber(p.amount), 0);
    const repairs = store.repairs.filter((r) => r.articleId === a.id).reduce((s, r) => s + toNumber(r.repairCost) - toNumber(r.costRecovered), 0);
    return { article: a, earned: pays - refund, repairCost: repairs, net: pays - refund - repairs, issued: store.rentals.filter((r) => r.articleId === a.id).length };
  }).sort((a, b) => b.net - a.net);

  const depositPending = active.map((r) => ({ rental: r, deposit: toNumber(r.deposit) }));
  const purchaseBills = store.articles.filter((a) => a.purchaseBill || a.purchaseDate || a.warrantyTill);

  return (
    <div className="reports-grid">
      <ReportBox title="Active Rental Report" rows={active} empty="No active rentals." render={(r) => <ReportLine key={r.id} title={`${r.articleSnapshot} · ${r.issueNo}`} meta={`${r.customerName} · ${r.siteName} · Qty ${r.outstanding} · Due ${fmtDate(r.expectedReturnDate)}`} value={money(toNumber(r.rentRate) * r.outstanding)} />} />
      <ReportBox title="Overdue Article Report" rows={overdue} empty="No overdue article." render={(r) => <ReportLine key={r.id} title={`${r.articleSnapshot} · ${r.overdueDays} day(s) late`} meta={`${r.customerName} · ${r.mobile} · ${r.siteName}`} value={fmtDate(r.expectedReturnDate)} danger />} />
      <ReportBox title="Damage Report" rows={damageReturns} empty="No damage returns." render={(r) => <ReportLine key={r.id} title={`${store.articles.find(a => a.id === r.articleId)?.articleName || 'Article'} · ${r.conditionAfter}`} meta={r.damageDescription || 'Damage/missing deduction'} value={money(r.damageDeduction)} danger />} />
      <ReportBox title="Repair Cost Report" rows={store.repairs} empty="No repairs." footer={`Total repair cost: ${money(repairTotal)}`} render={(r) => <ReportLine key={r.id} title={`${store.articles.find(a => a.id === r.articleId)?.articleName || 'Article'} · ${r.issueType}`} meta={`${fmtDate(r.repairDate)} · ${r.reason}`} value={money(r.repairCost)} />} />
      <ReportBox title="Customer-wise Rental Report" rows={customerWise} empty="No active customer rentals." render={(r) => <ReportLine key={r.name} title={r.name} meta={`Active slips ${r.count} · Qty outside ${r.qty}`} value={money(r.deposit)} />} />
      <ReportBox title="Contractor-wise Rental Report" rows={contractorWise} empty="No contractor rentals." render={(r) => <ReportLine key={r.name} title={r.name} meta={`Qty ${r.qty} · Sites: ${r.sites || '-'}`} value={`${r.count} slips`} />} />
      <ReportBox title="Article-wise Profit Report" rows={articleProfit} empty="No article records." render={(r) => <ReportLine key={r.article.id} title={`${r.article.articleName} · ${r.article.articleCode}`} meta={`Issued ${r.issued} times · Available ${articleAvailableQty(r.article.id)} / ${r.article.qtyTotal} · Repair ${money(r.repairCost)}`} value={money(r.net)} />} />
      <ReportBox title="Lost Article Report" rows={lostArticles} empty="No lost articles." render={(a) => <ReportLine key={a.id} title={`${a.articleName} · ${a.articleCode}`} meta={`${a.category} / ${a.subcategory || '-'} · Replacement ${money(a.replacementCost)}`} value={a.status} danger />} />
      <ReportBox title="Deposit Pending Report" rows={depositPending} empty="No deposits currently held." render={(r) => <ReportLine key={r.rental.id} title={`${r.rental.customerName} · ${r.rental.issueNo}`} meta={`${r.rental.articleSnapshot} · Due ${fmtDate(r.rental.expectedReturnDate)}`} value={money(r.deposit)} />} />
      <ReportBox title="Purchase Bill / Warranty Report" rows={purchaseBills} empty="No purchase bill records." render={(a) => <ReportLine key={a.id} title={`${a.articleName} · ${a.articleCode}`} meta={`Purchased ${fmtDate(a.purchaseDate)} · Vendor ${a.vendorName || '-'} · Warranty ${fmtDate(a.warrantyTill)}`} value={a.purchaseBill ? 'Bill uploaded' : 'Bill missing'} danger={!a.purchaseBill} />} />
    </div>
  );
}

function ReportBox({ title, rows, render, empty, footer }) {
  return <section className="panel report-box"><h2>{title}</h2><div className="report-lines">{rows.map(render)}{rows.length === 0 && <Empty text={empty} />}</div>{footer && <div className="report-footer">{footer}</div>}</section>;
}

function ReportLine({ title, meta, value, danger }) {
  return <div className="report-line"><div><b>{title}</b><small>{meta}</small></div><span className={danger ? 'danger-text' : ''}>{value}</span></div>;
}

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()];
}



function attendanceStatus(record) {
  if (!record) return { label: 'Not Checked In', tone: 'gray' };
  if (record.status === 'Completed' || record.checkOutAt) return { label: 'Checked Out', tone: 'green' };
  return { label: 'Checked In', tone: 'blue' };
}

function timeHM(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function gpsText(lat, lon, accuracy) {
  if (!lat || !lon) return '-';
  const acc = accuracy ? ` · ±${Math.round(Number(accuracy))}m` : '';
  return `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}${acc}`;
}

function mapsUrl(lat, lon) {
  if (!lat || !lon) return '#';
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

function getGpsPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS/geolocation is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = Number(pos.coords.accuracy || 0);
        const warning = accuracy > 200 ? `Low GPS accuracy: ±${Math.round(accuracy)}m` : '';
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy,
          warning,
          capturedAt: new Date().toISOString()
        });
      },
      (error) => reject(new Error(error.message || 'GPS permission denied')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}


function SalaryPayrollModule({ store, saveStore, notify, currentUser, isOwner }) {
  const role = currentUser?.role || store.settings?.roleMode || 'Field Staff';
  const canManage = role === 'Owner';
  const canViewAll = ['Owner', 'Operations Manager'].includes(role);
  const currentStaffKey = currentUser?.id || currentUser?.email || '';
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [staffForm, setStaffForm] = useState({ staffName: '', userId: '', role: 'Field Staff', mobile: '', baseSalary: '', monthlyAllowance: '', monthlyDeduction: '', weeklyOffDay: normalizeSalaryRules(store.salaryRules).defaultWeeklyOffDay, status: 'Active' });
  const [leaveForm, setLeaveForm] = useState({ staffId: '', type: 'Approved Leave', fromDate: todayISO(), toDate: todayISO(), reason: '' });
  const [rules, setRules] = useState(normalizeSalaryRules(store.salaryRules || {}));

  const staffList = getStaffList(store, currentUser);
  const visibleStaff = canViewAll ? staffList : staffList.filter((staff) => staff.id === currentStaffKey || staff.userId === currentStaffKey || staff.staffName === currentUser?.full_name || staff.staffName === currentUser?.email);
  const payrollRows = visibleStaff.map((staff) => computeStaffPayroll(store, staff, month));
  const savedRuns = (store.payrollRuns || []).filter((run) => !month || run.month === month).sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  const totalNet = payrollRows.reduce((sum, row) => sum + toNumber(row.netSalary), 0);
  const totalDeductions = payrollRows.reduce((sum, row) => sum + toNumber(row.totalDeductions), 0);
  const totalWeeklyBonus = payrollRows.reduce((sum, row) => sum + toNumber(row.weeklyOffBonus), 0);

  function updateStaff(field, value) {
    setStaffForm((f) => ({ ...f, [field]: value }));
  }

  function saveStaff(e) {
    e.preventDefault();
    if (!canManage) return notify('Only Owner can add or edit salary slabs');
    if (!staffForm.staffName.trim()) return notify('Enter staff name');
    const row = { ...staffForm, id: staffForm.id || uid('STF'), staffName: staffForm.staffName.trim(), baseSalary: toNumber(staffForm.baseSalary), monthlyAllowance: toNumber(staffForm.monthlyAllowance), monthlyDeduction: toNumber(staffForm.monthlyDeduction), updatedAt: new Date().toISOString() };
    saveStore((prev) => {
      const exists = (prev.staffProfiles || []).some((s) => s.id === row.id);
      return { ...prev, staffProfiles: exists ? (prev.staffProfiles || []).map((s) => s.id === row.id ? row : s) : [row, ...(prev.staffProfiles || [])] };
    }, `Owner saved salary slab for ${row.staffName}`, 'Salary');
    setStaffForm({ staffName: '', userId: '', role: 'Field Staff', mobile: '', baseSalary: '', monthlyAllowance: '', monthlyDeduction: '', weeklyOffDay: rules.defaultWeeklyOffDay, status: 'Active' });
    notify('Staff salary slab saved');
  }

  function editStaff(staff) {
    if (!canManage) return;
    setStaffForm({ ...staff, baseSalary: staff.baseSalary || '', monthlyAllowance: staff.monthlyAllowance || '', monthlyDeduction: staff.monthlyDeduction || '' });
  }

  function saveLeave(e) {
    e.preventDefault();
    const staff = staffList.find((s) => s.id === leaveForm.staffId || s.userId === leaveForm.staffId);
    if (!staff) return notify('Select staff');
    if (!canManage && !(staff.id === currentStaffKey || staff.userId === currentStaffKey)) return notify('You can add leave only for yourself');
    const type = leaveForm.type || 'Approved Leave';
    const row = { id: uid('LEV'), ...leaveForm, staffId: staff.id, staffName: staff.staffName, type, status: type === 'Approved Leave' ? 'Approved' : 'Unapproved', createdBy: currentUser?.full_name || currentUser?.email || role, createdAt: new Date().toISOString() };
    saveStore((prev) => ({ ...prev, leaveRequests: [row, ...(prev.leaveRequests || [])] }), `${row.type} recorded for ${staff.staffName}`, 'Salary');
    setLeaveForm({ staffId: '', type: 'Approved Leave', fromDate: todayISO(), toDate: todayISO(), reason: '' });
    notify('Leave/absent entry saved');
  }

  function saveRules(e) {
    e.preventDefault();
    if (!canManage) return notify('Only Owner can change salary rules');
    const clean = normalizeSalaryRules(rules);
    saveStore((prev) => ({ ...prev, salaryRules: clean, settings: normalizeSettings({ ...prev.settings, salaryRules: clean }) }), 'Owner updated salary rules', 'Salary');
    notify('Salary rules saved');
  }

  function generatePayrollRun() {
    if (!canManage) return notify('Only Owner can generate payroll');
    const rows = staffList.map((staff) => computeStaffPayroll(store, staff, month));
    const run = { id: uid('PAY'), month, status: 'Draft', generatedAt: new Date().toISOString(), generatedBy: currentUser?.full_name || currentUser?.email || 'Owner', rows, totals: { staff: rows.length, netSalary: rows.reduce((s, r) => s + toNumber(r.netSalary), 0), deductions: rows.reduce((s, r) => s + toNumber(r.totalDeductions), 0), weeklyOffBonus: rows.reduce((s, r) => s + toNumber(r.weeklyOffBonus), 0) } };
    saveStore((prev) => ({ ...prev, payrollRuns: [run, ...(prev.payrollRuns || [])], expenses: [{ id: uid('EXP'), date: todayISO(), category: 'Staff Salary', description: `Payroll ${month}`, amount: run.totals.netSalary, paymentMode: 'Bank', linkedPayrollRunId: run.id, status: 'Active', createdAt: new Date().toISOString() }, ...(prev.expenses || [])] }), `Owner generated payroll for ${month}`, 'Salary');
    notify('Payroll generated and salary expense added');
  }

  function voidPayrollRun(runId) {
    if (!canManage) return;
    const reason = prompt('Reason for voiding this payroll run?');
    if (!reason) return;
    saveStore((prev) => ({
      ...prev,
      payrollRuns: (prev.payrollRuns || []).map((run) => run.id === runId ? { ...run, status: 'Void', voidedAt: new Date().toISOString(), voidReason: reason } : run),
      expenses: (prev.expenses || []).map((expense) => expense.linkedPayrollRunId === runId ? { ...expense, status: 'Void', voidedAt: new Date().toISOString(), voidReason: reason } : expense)
    }), 'Owner voided payroll run', 'Salary');
    notify('Payroll run voided; audit history preserved');
  }

  function printPayslip(row) {
    const html = `<h1>Salary Slip</h1><p class="muted">${escapeHtml(store.settings?.firmName || 'Rental Services OS')} · ${escapeHtml(month)}</p><div class="meta"><div><b>Staff</b><br>${escapeHtml(row.staffName)}</div><div><b>Role</b><br>${escapeHtml(row.role)}</div><div><b>Present Days</b><br>${row.presentDays}</div><div><b>Weekly Off Worked</b><br>${row.weeklyOffWorked}/${row.weeklyOffCount}</div></div><table><tr><th>Component</th><th class="right">Amount</th></tr><tr><td>Base Salary</td><td class="right">${money(row.baseSalary)}</td></tr><tr><td>Allowance</td><td class="right">${money(row.allowance)}</td></tr><tr><td>Weekly-off Bonus</td><td class="right">${money(row.weeklyOffBonus)}</td></tr><tr><td>Approved Leave Deduction (${row.approvedLeaveDays} days)</td><td class="right">-${money(row.approvedDeduction)}</td></tr><tr><td>Unapproved Leave / Absentee Deduction (${row.unapprovedLeaveDays} days)</td><td class="right">-${money(row.unapprovedDeduction + row.absenteePenalty)}</td></tr><tr><td>Manual Deduction</td><td class="right">-${money(row.manualDeduction)}</td></tr><tr><th>Net Salary</th><th class="right">${money(row.netSalary)}</th></tr></table>`;
    printDocument(`Payslip ${row.staffName} ${month}`, html);
  }

  return (
    <div className="stack">
      <Section title="Salary / Payroll" subtitle="Approved leave, unapproved absentee deduction, weekly-off tracking and bonus when weekly leave is not taken.">
        <div className="stats-grid">
          <StatCard label="Payroll Month" value={month} hint="Select month below" tone="blue" />
          <StatCard label="Net Salary" value={money(totalNet)} hint="Computed for visible staff" tone="green" />
          <StatCard label="Leave Deductions" value={money(totalDeductions)} hint="Approved + absentee + manual" tone="orange" />
          <StatCard label="Weekly-off Bonus" value={money(totalWeeklyBonus)} hint="Paid for weekly offs worked" tone="blue" />
        </div>
        <div className="form-grid compact-form">
          <Field label="Payroll Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value || todayISO().slice(0, 7))} /></Field>
          {canManage && <div className="form-actions"><button type="button" onClick={generatePayrollRun}>Generate Payroll Run</button></div>}
        </div>
      </Section>

      {canManage && <Section title="Salary Rules" subtitle="Owner controls different deduction rates for approved leave and unapproved absentee.">
        <form className="form-grid" onSubmit={saveRules}>
          <Field label="Approved Leave Deduction %"><input type="number" value={rules.approvedLeaveDeductionPercent} onChange={(e) => setRules((r) => ({ ...r, approvedLeaveDeductionPercent: toNumber(e.target.value) }))} /></Field>
          <Field label="Unapproved / Absentee Deduction %"><input type="number" value={rules.unapprovedLeaveDeductionPercent} onChange={(e) => setRules((r) => ({ ...r, unapprovedLeaveDeductionPercent: toNumber(e.target.value) }))} /></Field>
          <Field label="Absentee Penalty / Day"><input type="number" value={rules.absenteePenaltyPerDay} onChange={(e) => setRules((r) => ({ ...r, absenteePenaltyPerDay: toNumber(e.target.value) }))} /></Field>
          <Field label="Default Weekly Off"><select value={rules.defaultWeeklyOffDay} onChange={(e) => setRules((r) => ({ ...r, defaultWeeklyOffDay: e.target.value }))}>{weekDays.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Weekly-off Bonus / Worked Off"><input type="number" value={rules.weeklyOffBonusAmount} onChange={(e) => setRules((r) => ({ ...r, weeklyOffBonusAmount: toNumber(e.target.value) }))} /></Field>
          <div className="form-actions wide"><button type="submit">Save Salary Rules</button></div>
        </form>
      </Section>}

      {canManage && <Section title="Staff Salary Slabs" subtitle="Only Owner can set base salary, allowance, deduction and weekly-off day.">
        <form className="form-grid" onSubmit={saveStaff}>
          <Field label="Staff Name" required><input value={staffForm.staffName} onChange={(e) => updateStaff('staffName', e.target.value)} /></Field>
          <Field label="Supabase User ID / Email"><input value={staffForm.userId || ''} onChange={(e) => updateStaff('userId', e.target.value)} placeholder="Optional, for exact login mapping" /></Field>
          <Field label="Role"><select value={staffForm.role} onChange={(e) => updateStaff('role', e.target.value)}><option>Owner</option><option>Operations Manager</option><option>Field Staff</option></select></Field>
          <Field label="Mobile"><input value={staffForm.mobile || ''} onChange={(e) => updateStaff('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
          <Field label="Base Salary"><input type="number" value={staffForm.baseSalary} onChange={(e) => updateStaff('baseSalary', e.target.value)} /></Field>
          <Field label="Monthly Allowance"><input type="number" value={staffForm.monthlyAllowance} onChange={(e) => updateStaff('monthlyAllowance', e.target.value)} /></Field>
          <Field label="Monthly Deduction"><input type="number" value={staffForm.monthlyDeduction} onChange={(e) => updateStaff('monthlyDeduction', e.target.value)} /></Field>
          <Field label="Weekly Off"><select value={staffForm.weeklyOffDay} onChange={(e) => updateStaff('weeklyOffDay', e.target.value)}>{weekDays.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <div className="form-actions wide"><button type="submit">Save Salary Slab</button></div>
        </form>
      </Section>}

      <Section title="Leave / Absentee Entry" subtitle="Approved leave and unapproved leave/absentee use different deduction rules.">
        <form className="form-grid" onSubmit={saveLeave}>
          <Field label="Staff" required><select value={leaveForm.staffId} onChange={(e) => setLeaveForm((f) => ({ ...f, staffId: e.target.value }))}><option value="">Select staff</option>{visibleStaff.map((s) => <option key={s.id} value={s.id}>{s.staffName} · {s.role}</option>)}</select></Field>
          <Field label="Leave Type"><select value={leaveForm.type} onChange={(e) => setLeaveForm((f) => ({ ...f, type: e.target.value }))}>{leaveTypes.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="From"><input type="date" value={leaveForm.fromDate} onChange={(e) => setLeaveForm((f) => ({ ...f, fromDate: e.target.value }))} /></Field>
          <Field label="To"><input type="date" value={leaveForm.toDate} onChange={(e) => setLeaveForm((f) => ({ ...f, toDate: e.target.value }))} /></Field>
          <Field label="Reason / Note"><input value={leaveForm.reason} onChange={(e) => setLeaveForm((f) => ({ ...f, reason: e.target.value }))} /></Field>
          <div className="form-actions wide"><button type="submit">Save Leave / Absentee</button></div>
        </form>
      </Section>

      <Section title="Payroll Calculation" subtitle="Generated from salary slab + GPS attendance + leave/absent entries + weekly-off work.">
        <div className="table-wrap payroll-table-wrap"><table><thead><tr><th>Staff</th><th>Attendance</th><th>Leaves</th><th>Weekly-off Bonus</th><th>Deductions</th><th>Net Salary</th><th>Action</th></tr></thead><tbody>{payrollRows.map((row) => <tr key={row.staffId}><td><b>{row.staffName}</b><br /><small>{row.role} · Base {money(row.baseSalary)}</small></td><td>{row.presentDays} present<br /><small>{row.completedDays} completed</small></td><td>Approved: {row.approvedLeaveDays}<br />Absent: {row.unapprovedLeaveDays}</td><td>{row.weeklyOffWorked}/{row.weeklyOffCount}<br /><b>{money(row.weeklyOffBonus)}</b></td><td>{money(row.totalDeductions)}<br /><small>Approved {money(row.approvedDeduction)} · Absent {money(row.unapprovedDeduction + row.absenteePenalty)}</small></td><td><b>{money(row.netSalary)}</b></td><td><button className="ghost" onClick={() => printPayslip(row)}>Payslip</button>{canManage && <button className="ghost" onClick={() => editStaff(staffList.find((s) => s.id === row.staffId) || row)}>Edit Slab</button>}</td></tr>)}</tbody></table>{payrollRows.length === 0 && <Empty text="No staff found. Add salary slabs or record attendance first." />}</div>
      </Section>

      <Section title="Saved Payroll Runs" subtitle="Owner-generated payroll snapshots. Salary expense is added to accounting when generated.">
        <div className="table-wrap"><table><thead><tr><th>Month</th><th>Generated</th><th>Staff</th><th>Net Salary</th><th>Deductions</th><th>Weekly Bonus</th><th>Action</th></tr></thead><tbody>{savedRuns.map((run) => <tr key={run.id}><td>{run.month}</td><td>{new Date(run.generatedAt).toLocaleString('en-IN')}</td><td>{run.totals?.staff || run.rows?.length || 0}</td><td>{money(run.totals?.netSalary)}</td><td>{money(run.totals?.deductions)}</td><td>{money(run.totals?.weeklyOffBonus)}</td><td>{canManage ? <button className="danger ghost" onClick={() => voidPayrollRun(run.id)}>Void</button> : <span className="muted">Owner only</span>}</td></tr>)}</tbody></table>{savedRuns.length === 0 && <Empty text="No payroll run generated for this month." />}</div>
      </Section>
    </div>
  );
}

function AttendanceModule({ store, saveStore, notify, currentUser, isOwner }) {
  const role = currentUser?.role || store.settings?.roleMode || 'Field Staff';
  const canViewAll = ['Owner', 'Operations Manager'].includes(role);
  const staffName = currentUser?.full_name || currentUser?.email || role || 'Staff';
  const staffId = currentUser?.id || currentUser?.email || role;
  const today = todayISO();
  const [note, setNote] = useState('');
  const [checkoutNote, setCheckoutNote] = useState('');
  const [filterDate, setFilterDate] = useState(today);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [error, setError] = useState('');

  const allAttendance = store.attendance || [];
  const myOpen = allAttendance.find((row) => row.userId === staffId && row.date === today && !row.checkOutAt && row.status !== 'Void');
  const myToday = allAttendance.find((row) => row.userId === staffId && row.date === today && row.status !== 'Void');
  const visibleRows = allAttendance
    .filter((row) => row.status !== 'Void')
    .filter((row) => canViewAll || row.userId === staffId)
    .filter((row) => !filterDate || row.date === filterDate)
    .sort((a, b) => String(b.checkInAt || '').localeCompare(String(a.checkInAt || '')));

  const todayRows = allAttendance.filter((row) => row.date === today && row.status !== 'Void');
  const presentNow = todayRows.filter((row) => row.checkInAt && !row.checkOutAt).length;
  const completedToday = todayRows.filter((row) => row.checkOutAt).length;
  const myStatus = attendanceStatus(myToday);

  async function doCheckIn() {
    setError('');
    if (myOpen) {
      notify('You are already checked in. Check out first.');
      return;
    }
    setGpsBusy(true);
    try {
      const gps = await getGpsPosition();
      const record = {
        id: uid('ATT'),
        userId: staffId,
        staffName,
        role,
        date: today,
        status: 'Checked In',
        checkInAt: new Date().toISOString(),
        checkInLat: gps.lat,
        checkInLon: gps.lon,
        checkInAccuracy: gps.accuracy,
        checkInGpsWarning: gps.warning || '',
        checkInGpsCapturedAt: gps.capturedAt,
        checkInNote: note.trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveStore((prev) => ({ ...prev, attendance: [record, ...(prev.attendance || [])] }), 'Staff checked in with GPS', 'Attendance');
      setNote('');
      notify(gps.warning ? `Check-in saved, but ${gps.warning}` : 'Check-in saved with GPS');
    } catch (err) {
      const msg = err.message || 'Could not capture GPS';
      setError(msg);
      notify(msg);
    } finally {
      setGpsBusy(false);
    }
  }

  async function doCheckOut() {
    setError('');
    if (!myOpen) {
      notify('No active check-in found for today');
      return;
    }
    setGpsBusy(true);
    try {
      const gps = await getGpsPosition();
      saveStore((prev) => ({
        ...prev,
        attendance: (prev.attendance || []).map((row) => row.id === myOpen.id ? {
          ...row,
          status: 'Completed',
          checkOutAt: new Date().toISOString(),
          checkOutLat: gps.lat,
          checkOutLon: gps.lon,
          checkOutAccuracy: gps.accuracy,
          checkOutGpsWarning: gps.warning || '',
          checkOutGpsCapturedAt: gps.capturedAt,
          checkOutNote: checkoutNote.trim(),
          updatedAt: new Date().toISOString()
        } : row)
      }), 'Staff checked out with GPS', 'Attendance');
      setCheckoutNote('');
      notify(gps.warning ? `Check-out saved, but ${gps.warning}` : 'Check-out saved with GPS');
    } catch (err) {
      const msg = err.message || 'Could not capture GPS';
      setError(msg);
      notify(msg);
    } finally {
      setGpsBusy(false);
    }
  }

  function ownerVoid(record) {
    if (!isOwner) return;
    if (!confirm('Remove/void this attendance record? It will stay in audit history.')) return;
    saveStore((prev) => ({
      ...prev,
      attendance: (prev.attendance || []).map((row) => row.id === record.id ? { ...row, status: 'Void', voidedAt: new Date().toISOString(), voidedBy: staffName } : row)
    }), `Owner voided attendance of ${record.staffName}`, 'Attendance');
    notify('Attendance record voided by Owner');
  }

  const openRows = todayRows.filter((r) => r.checkInAt && !r.checkOutAt && r.status !== 'Void');

  return (
    <div className="stack">
      <Section title="Staff Attendance" subtitle="GPS based check-in and check-out. Supabase stores attendance data; Google Drive is not needed unless proof media is attached elsewhere.">
        <div className="stats-grid">
          <StatCard label="My Status" value={myStatus.label} hint={fmtDate(today)} tone={myStatus.tone} />
          <StatCard label="Present Now" value={presentNow} hint="Checked in but not checked out" tone="blue" />
          <StatCard label="Completed Today" value={completedToday} hint="Checked out records" tone="green" />
          <StatCard label="GPS Rule" value="Required" hint="Manual coordinates disabled" tone="orange" />
        </div>
        <div className="attendance-actions">
          <div className="attendance-card">
            <h3>Check In</h3>
            <p>Capture current GPS at the start of duty, site visit, pickup route, or shop work.</p>
            <Field label="Check-in note"><textarea rows="3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Example: Starting pickup route / At shop / Site visit started" /></Field>
            <button onClick={doCheckIn} disabled={gpsBusy || Boolean(myOpen)}>{gpsBusy ? 'Capturing GPS...' : myOpen ? 'Already Checked In' : 'Check In with GPS'}</button>
          </div>
          <div className="attendance-card">
            <h3>Check Out</h3>
            <p>Capture GPS again before leaving duty. This closes the daily attendance record.</p>
            <Field label="Check-out note"><textarea rows="3" value={checkoutNote} onChange={(e) => setCheckoutNote(e.target.value)} placeholder="Example: Delivery completed / Shop closed / Returned from site" /></Field>
            <button className="secondary" onClick={doCheckOut} disabled={gpsBusy || !myOpen}>{gpsBusy ? 'Capturing GPS...' : 'Check Out with GPS'}</button>
          </div>
        </div>
        {error && <div className="alert alert-danger">{error}. Allow location permission and keep GPS/location enabled.</div>}
      </Section>

      {canViewAll && openRows.length > 0 && (
        <Section title="Live Staff On Duty" subtitle="Staff currently checked in today and not checked out.">
          <div className="card-list">
            {openRows.map((row) => <AttendanceCard key={row.id} row={row} isOwner={isOwner} onVoid={ownerVoid} />)}
          </div>
        </Section>
      )}

      <Section title="Attendance History" subtitle={canViewAll ? 'Owner/Operations can view all staff attendance.' : 'Field Staff can view only their own attendance.'} right={<Field label="Date Filter"><input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} /></Field>}>
        {visibleRows.length === 0 ? <div className="empty-state-actions"><Empty text="No attendance record found. Check in with GPS and attendance will appear here." /><button type="button" className="ghost" onClick={() => setFilterDate(today)}>Show Today</button></div> : (
          <div className="table-wrap attendance-table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Staff</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Check-in GPS</th><th>Check-out GPS</th><th>Notes</th><th>Action</th></tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const st = attendanceStatus(row);
                  return <tr key={row.id}>
                    <td>{fmtDate(row.date)}</td>
                    <td><b>{row.staffName}</b><br /><small>{row.role}</small></td>
                    <td><Badge tone={st.tone}>{st.label}</Badge></td>
                    <td>{timeHM(row.checkInAt)}</td>
                    <td>{timeHM(row.checkOutAt)}</td>
                    <td>{row.checkInLat ? <a href={mapsUrl(row.checkInLat, row.checkInLon)} target="_blank" rel="noreferrer">{gpsText(row.checkInLat, row.checkInLon, row.checkInAccuracy)}</a> : '-'}</td>
                    <td>{row.checkOutLat ? <a href={mapsUrl(row.checkOutLat, row.checkOutLon)} target="_blank" rel="noreferrer">{gpsText(row.checkOutLat, row.checkOutLon, row.checkOutAccuracy)}</a> : '-'}</td>
                    <td><small>{row.checkInNote || '-'}{row.checkOutNote ? <><br />Out: {row.checkOutNote}</> : null}</small></td>
                    <td>{isOwner ? <button className="danger ghost" onClick={() => ownerVoid(row)}>Void</button> : <span className="muted">Owner only</span>}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function AttendanceCard({ row, isOwner, onVoid }) {
  const st = attendanceStatus(row);
  return (
    <div className="record-card attendance-record-card">
      <div className="record-top">
        <div><h3>{row.staffName}</h3><p>{fmtDate(row.date)} · {row.role}</p></div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="record-grid">
        <span><b>In</b>{timeHM(row.checkInAt)}</span>
        <span><b>Out</b>{timeHM(row.checkOutAt)}</span>
        <span><b>Check-in GPS</b>{row.checkInLat ? <a href={mapsUrl(row.checkInLat, row.checkInLon)} target="_blank" rel="noreferrer">Open Map</a> : '-'}</span>
        <span><b>Check-out GPS</b>{row.checkOutLat ? <a href={mapsUrl(row.checkOutLat, row.checkOutLon)} target="_blank" rel="noreferrer">Open Map</a> : '-'}</span>
      </div>
      {(row.checkInNote || row.checkOutNote) && <p className="muted">{row.checkInNote}{row.checkOutNote ? ` · Out: ${row.checkOutNote}` : ''}</p>}
      {isOwner && <button className="danger ghost" onClick={() => onVoid(row)}>Owner Void</button>}
    </div>
  );
}

function SettingsPanel({ store, saveStore, notify, driveState, connectDrive, uploadToDrive, supabaseState, connectSupabase, syncToSupabase, loadFromSupabase }) {
  const current = normalizeSettings(store.settings);
  const [form, setForm] = useState(current);
  const files = collectAttachedFiles(store);
  const driveFiles = files.filter((x) => x.file?.source === 'googleDrive');
  const localFiles = files.filter((x) => !['googleDrive', 'supabase'].includes(x.file?.source));

  useEffect(() => {
    setForm(normalizeSettings(store.settings));
  }, [store.settings]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function saveSettings(e) {
    e.preventDefault();
    saveStore((prev) => ({ ...prev, settings: normalizeSettings(form) }));
    notify('Settings saved');
  }

  async function connectSupabaseFromForm() {
    saveStore((prev) => ({ ...prev, settings: normalizeSettings(form) }));
    await connectSupabase(form);
  }

  async function saveToSupabaseNow() {
    saveStore((prev) => ({ ...prev, settings: normalizeSettings(form) }));
    await syncToSupabase();
  }

  async function uploadBackupNow() {
    try {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      const uploaded = await uploadToDrive(new File([blob], `rental-services-backup-${todayISO()}.json`, { type: 'application/json' }), { label: form.driveBackupName || 'Backups' });
      notify(`Backup saved in Google Drive: ${uploaded.name}`);
    } catch (error) {
      notify(error.message || 'Drive backup failed');
    }
  }


  async function migrateLocalFilesToDrive() {
    if (!driveState.connected) return notify('Connect Google Drive first');
    const pending = collectAttachedFiles(store).filter((row) => !['googleDrive', 'supabase'].includes(row.file?.source) && row.file?.dataUrl);
    if (pending.length === 0) return notify('No local attachments to migrate');
    let nextStore = store;
    let uploadedCount = 0;
    try {
      for (const row of pending) {
        const file = await dataUrlToFile(row.file, `${row.area}-${uploadedCount + 1}`);
        const uploaded = await uploadToDrive(file, { label: row.area });
        nextStore = replaceAttachmentInStore(nextStore, row.path, uploaded);
        uploadedCount += 1;
      }
      saveStore(nextStore);
      notify(`${uploadedCount} local attachment(s) migrated to Google Drive`);
    } catch (error) {
      if (uploadedCount > 0) saveStore(nextStore);
      notify(error.message || 'Local attachment migration failed');
    }
  }



  return (
    <>
      <Section title="Settings" subtitle="Supabase handles login + data. Google Drive handles media files.">
        <form className="form-grid" onSubmit={saveSettings}>
          <Field label="Firm Name"><input value={form.firmName} onChange={(e) => update('firmName', e.target.value)} /></Field>
          <Field label="Issue Slip Prefix"><input value={form.receiptPrefix} onChange={(e) => update('receiptPrefix', e.target.value.toUpperCase())} /></Field>

          <div className="wide divider-title">Supabase Auth + Database</div>
          <label className="terms"><input type="checkbox" checked={Boolean(form.supabaseEnabled)} onChange={(e) => update('supabaseEnabled', e.target.checked)} /> <span>Enable Supabase login + database</span></label>
          <label className="terms"><input type="checkbox" checked={Boolean(form.supabaseAutoSyncData)} onChange={(e) => update('supabaseAutoSyncData', e.target.checked)} /> <span>Auto-save business data to Supabase</span></label>
          <label className="terms"><input type="checkbox" checked={Boolean(form.localCacheBusinessData)} onChange={(e) => update('localCacheBusinessData', e.target.checked)} /> <span>Emergency only: cache business records in this browser. Keep OFF for shared/mobile devices.</span></label>
          <Field label="Supabase Project URL"><input value={form.supabaseUrl} onChange={(e) => update('supabaseUrl', e.target.value)} placeholder="https://xxxx.supabase.co" /></Field>
          <Field label="Supabase Anon Public Key"><input value={form.supabaseAnonKey} onChange={(e) => update('supabaseAnonKey', e.target.value)} placeholder="eyJhbGciOi..." /></Field>
          <Field label="Data Storage Mode"><select value={form.supabaseDataMode || 'relational'} onChange={(e) => update('supabaseDataMode', e.target.value)}><option value="relational">Relational tables with RLS</option><option value="snapshot">Legacy JSON snapshot fallback</option></select></Field>
          <label className="terms"><input type="checkbox" checked={form.supabaseRelationalEnabled !== false} onChange={(e) => update('supabaseRelationalEnabled', e.target.checked)} /> <span>Use separate Supabase tables for customers, articles, rentals, tasks, attendance, payroll and media</span></label>
          <Field label="Snapshot Table (fallback only)"><input value={form.supabaseSnapshotTable} onChange={(e) => update('supabaseSnapshotTable', e.target.value)} placeholder="rental_app_snapshots" /></Field>
          <Field label="Snapshot ID (fallback only)"><input value={form.supabaseSnapshotId} onChange={(e) => update('supabaseSnapshotId', e.target.value)} placeholder="main" /></Field>
          <div className="form-actions wide"><button type="submit">Save Settings</button><button type="button" className="ghost" onClick={connectSupabaseFromForm} disabled={!form.supabaseEnabled || !form.supabaseUrl || !form.supabaseAnonKey}>Connect Supabase</button>{supabaseState.connected && <button type="button" className="ghost" onClick={saveToSupabaseNow}>Save Data to Supabase</button>}{supabaseState.connected && <button type="button" className="ghost" onClick={loadFromSupabase}>Load Data from Supabase</button>}</div>

          <div className="wide divider-title">Google Drive Media Storage</div>
          <label className="terms"><input type="checkbox" checked={Boolean(form.driveEnabled)} onChange={(e) => update('driveEnabled', e.target.checked)} /> <span>Enable Google Drive for media files</span></label>
          <label className="terms"><input type="checkbox" checked={Boolean(form.driveAutoUploadFiles)} onChange={(e) => update('driveAutoUploadFiles', e.target.checked)} /> <span>Auto-upload photos, videos, bills, proofs and catalogues to Drive</span></label>
          <label className="terms"><input type="checkbox" checked={Boolean(form.driveLocalFallback)} onChange={(e) => update('driveLocalFallback', e.target.checked)} /> <span>Emergency only: if Drive upload fails, save file locally in this browser</span></label>
          <Field label="Google OAuth Web Client ID"><input value={form.driveClientId} onChange={(e) => update('driveClientId', e.target.value)} placeholder="1234567890-xxxx.apps.googleusercontent.com" /></Field>
          <Field label="Main Drive Folder"><input value={form.driveFolderName} onChange={(e) => update('driveFolderName', e.target.value)} placeholder="Rental Services OS" /></Field>
          <Field label="Backup Subfolder"><input value={form.driveBackupName} onChange={(e) => update('driveBackupName', e.target.value)} placeholder="rental-services-backups" /></Field>
          <div className="form-actions wide"><button type="button" className="ghost" onClick={() => { saveStore((prev) => ({ ...prev, settings: normalizeSettings(form) })); connectDrive(form.driveClientId); }} disabled={!form.driveEnabled || !form.driveClientId}>Connect Google Drive</button>{driveState.connected && <button type="button" className="ghost" onClick={uploadBackupNow}>Upload Backup to Drive</button>} {driveState.connected && localFiles.length > 0 && <button type="button" className="ghost" onClick={migrateLocalFilesToDrive}>Migrate Local Files to Drive</button>}</div>
        </form>
      </Section>

      <Section title="Cloud Status" subtitle="Supabase is used for login and business data. Google Drive is used for media files.">
        <div className="drive-grid">
          <div className="backup-card"><h3>Supabase</h3><p><b>{supabaseState.connected ? 'Connected' : 'Not connected'}</b></p><p className="muted">{supabaseState.status}</p><p className="muted">Mode: {(form.supabaseDataMode || 'relational') === 'relational' ? 'Relational tables + RLS' : 'Legacy snapshot'}</p></div>
          <div className="backup-card"><h3>Google Drive</h3><p><b>{driveState.connected ? 'Connected' : 'Not connected'}</b></p><p className="muted">{driveState.status}</p></div>
          <div className="backup-card"><h3>Drive Media Files</h3><p><b>{driveFiles.length}</b> attachment(s)</p><p className="muted">Photos, bills and proofs uploaded to Google Drive.</p></div>
          <div className="backup-card"><h3>Local Files</h3><p><b>{localFiles.length}</b> attachment(s)</p><p className="muted">Older/local files remain in JSON backup unless migrated.</p></div>
        </div>
        <div className="notes-grid">
          <div><b>Supabase setup</b><p>Run <code>supabase-setup.sql</code>, enable Email Auth, then paste Project URL and anon public key here.</p></div>
          <div><b>Data model used</b><p>This frontend build saves the business database snapshot in Supabase with authenticated user access. Media file links are stored in records, while files themselves stay in Google Drive.</p></div>
          <div><b>Security note</b><p>Role login is enforced through Supabase Auth and <code>app_users</code>. Owner can manage staff roles in Supabase table; UI permissions follow the signed-in role.</p></div>
        </div>
      </Section>

      <Section title="Attachment Register" subtitle="Quick view of where bills, photos and proofs are currently stored.">
        <div className="table-wrap compact"><table><thead><tr><th>Area</th><th>Record</th><th>File</th><th>Storage</th><th>Uploaded</th></tr></thead><tbody>{files.map((row, index) => <tr key={index}><td>{row.area}</td><td>{row.owner}</td><td><FileLink file={row.file} label={row.file?.name || 'View'} /></td><td><Badge tone={row.file?.source === 'googleDrive' ? 'green' : 'orange'}>{fileSourceLabel(row.file) || 'Local'}</Badge></td><td>{row.file?.uploadedAt ? new Date(row.file.uploadedAt).toLocaleString('en-IN') : '-'}</td></tr>)}</tbody></table>{files.length === 0 && <Empty text="No attachments uploaded yet." />}</div>
      </Section>
    </>
  );
}

function Backup({ store, saveStore, notify, uploadToDrive, driveState, supabaseState, syncToSupabase, loadFromSupabase }) {
  const [firmName, setFirmName] = useState(store.settings.firmName || 'Urban Interior & Decor');
  const [receiptPrefix, setReceiptPrefix] = useState(store.settings.receiptPrefix || 'ISS');
  const dataSize = new Blob([JSON.stringify(store)]).size;

  function exportJson() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rental-services-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function uploadBackupToDrive() {
    try {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      const uploaded = await uploadToDrive(new File([blob], `rental-services-backup-${todayISO()}.json`, { type: 'application/json' }), { label: store.settings.driveBackupName || 'Backups' });
      notify(`Backup saved in Google Drive: ${uploaded.name}`);
    } catch (error) {
      notify(error.message || 'Drive backup failed');
    }
  }

  async function importJson(file) {
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.articles) || !Array.isArray(parsed.rentals)) throw new Error('Invalid backup');
      saveStore(normalizeImportedStore(parsed, store.settings));
      notify('Backup imported');
    } catch {
      notify('Invalid backup file');
    }
  }

  function saveSettings(e) {
    e.preventDefault();
    saveStore((prev) => ({ ...prev, settings: { ...prev.settings, firmName, receiptPrefix } }));
    notify('Settings saved');
  }

  return (
    <>
      <Section title="Settings" subtitle="Basic firm and receipt settings.">
        <form className="form-grid" onSubmit={saveSettings}>
          <Field label="Firm Name"><input value={firmName} onChange={(e) => setFirmName(e.target.value)} /></Field>
          <Field label="Issue Slip Prefix"><input value={receiptPrefix} onChange={(e) => setReceiptPrefix(e.target.value.toUpperCase())} /></Field>
          <div className="form-actions wide"><button type="submit">Save Settings</button></div>
        </form>
      </Section>
      <Section title="Backup / Restore" subtitle="Supabase is the primary business database. Browser storage is only local cache; Google Drive stores media and backup files.">
        <div className="backup-grid">
          <div className="backup-card"><h3>Export backup</h3><p>Downloads all article, rental, return, repair and payment data as JSON.</p><button onClick={exportJson}>Download Backup</button></div>
          <div className="backup-card"><h3>Drive backup</h3><p>Uploads the full JSON backup into your Google Drive backup folder.</p><button onClick={uploadBackupToDrive} disabled={!driveState?.connected}>Upload to Drive</button></div>
          <div className="backup-card"><h3>Supabase snapshot</h3><p>Saves the current business data into your authenticated Supabase database snapshot.</p><button onClick={syncToSupabase} disabled={!supabaseState?.connected}>Save to Supabase</button></div>
          <div className="backup-card"><h3>Load Supabase</h3><p>Loads the latest authenticated Supabase business snapshot into this browser.</p><button onClick={loadFromSupabase} disabled={!supabaseState?.connected}>Load from Supabase</button></div>
          <div className="backup-card"><h3>Import backup</h3><p>Restore a previous JSON backup into this browser.</p><input type="file" accept="application/json,.json" onChange={(e) => importJson(e.target.files?.[0])} /></div>
          <div className="backup-card"><h3>Storage size</h3><p>Approx saved data size: <b>{Math.round(dataSize / 1024)} KB</b></p><p className="muted">Avoid storing too many large videos in LocalStorage. Use backend/cloud storage in production.</p></div>
        </div>
      </Section>
      <Section title="Production Notes" subtitle="What to add before real multi-user deployment.">
        <div className="notes-grid">
          <div><b>Database</b><p>This build now uses Supabase Auth + RLS snapshot storage. Later, normalize JSON snapshot into separate PostgreSQL tables with foreign keys.</p></div>
          <div><b>Photos/Bills</b><p>Store media files in Google Drive and save only Drive metadata/links in Supabase records.</p></div>
          <div><b>Roles</b><p>Owner, Operations Manager and Field Staff login comes from Supabase Auth/app_users. Keep RLS policies active.</p></div>
          <div><b>Audit Trail</b><p>Every issue, return, refund and damage edit should create non-deletable logs.</p></div>
        </div>
      </Section>
    </>
  );
}

function Empty({ text }) {
  return <div className="empty"><b>Nothing here yet</b><span>{text}</span></div>;
}

createRoot(document.getElementById('root')).render(<App />);
