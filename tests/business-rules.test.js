import test from 'node:test';
import assert from 'node:assert/strict';
import { canIssueQuantity, computeDepositSettlement, shouldLockPaidInvoice } from '../src/lib/businessRules.js';
import { escapeHtml, getAuthRedirectUrl, isValidSupabasePublicKey, isValidSupabaseUrl } from '../src/lib/security.js';

test('issue guard blocks zero and over-issue quantities', () => {
  assert.equal(canIssueQuantity({ requestedQty: 0, availableQty: 2 }).ok, false);
  assert.equal(canIssueQuantity({ requestedQty: 3, availableQty: 2 }).ok, false);
  assert.equal(canIssueQuantity({ requestedQty: 2, availableQty: 2 }).ok, true);
});

test('deposit settlement separates deduction from payable cash', () => {
  const result = computeDepositSettlement({ depositHeld: 1000, finalRent: 400, latePenalty: 100, damageDeduction: 1200, balanceCollected: 700, depositRefund: 200 });
  assert.equal(result.damageFromDeposit, 1000);
  assert.equal(result.extraDamagePayable, 200);
  assert.equal(result.payableNow, 700);
  assert.equal(result.maxRefund, 0);
  assert.equal(result.depositRefund, 0);
});

test('paid invoices are locked for owner reversal workflow', () => {
  assert.equal(shouldLockPaidInvoice({ id: 'INV1', status: 'Unpaid' }, []), false);
  assert.equal(shouldLockPaidInvoice({ id: 'INV1', status: 'Unpaid' }, [{ invoiceId: 'INV1', amount: 10 }]), true);
  assert.equal(shouldLockPaidInvoice({ id: 'INV2', status: 'Paid' }, []), true);
});

test('security helpers validate Supabase public config and HTML escaping', () => {
  assert.equal(isValidSupabaseUrl('https://abc123.supabase.co'), true);
  assert.equal(isValidSupabaseUrl('http://localhost:54321'), false);
  assert.equal(isValidSupabasePublicKey('sb_publishable_abc'), true);
  assert.equal(isValidSupabasePublicKey('eyJhbGciOi'), true);
  assert.equal(isValidSupabasePublicKey('sb_secret_abc'), false);
  assert.equal(getAuthRedirectUrl('https://app.vercel.app/'), 'https://app.vercel.app');
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});
