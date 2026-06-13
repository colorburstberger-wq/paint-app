export function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function clampQty(value, max = Infinity) {
  return Math.max(0, Math.min(toNumber(value), toNumber(max)));
}

export function canIssueQuantity({ requestedQty, availableQty }) {
  const requested = toNumber(requestedQty);
  const available = toNumber(availableQty);
  if (!requested || requested <= 0) return { ok: false, reason: 'Quantity must be greater than zero' };
  if (available <= 0) return { ok: false, reason: 'Selected article has no available stock' };
  if (requested > available) return { ok: false, reason: `Only ${available} available` };
  return { ok: true, requested, available };
}

export function computeDepositSettlement({ depositHeld = 0, finalRent = 0, latePenalty = 0, damageDeduction = 0, balanceCollected = 0, depositRefund = 0 }) {
  const deposit = Math.max(0, toNumber(depositHeld));
  const damage = Math.max(0, toNumber(damageDeduction));
  const damageFromDeposit = Math.min(deposit, damage);
  const extraDamagePayable = Math.max(0, damage - damageFromDeposit);
  const payableNow = Math.max(0, toNumber(finalRent) + toNumber(latePenalty) + extraDamagePayable);
  const collected = Math.max(0, toNumber(balanceCollected));
  const refund = Math.max(0, toNumber(depositRefund));
  const maxRefund = Math.max(0, deposit - damageFromDeposit);
  return {
    damageFromDeposit,
    extraDamagePayable,
    payableNow,
    collected,
    depositRefund: Math.min(refund, maxRefund),
    maxRefund,
    cashShortfall: Math.max(0, payableNow - collected)
  };
}

export function shouldLockPaidInvoice(invoice = {}, payments = []) {
  if (['Paid', 'Cancelled', 'Void'].includes(invoice.status)) return true;
  const paid = payments
    .filter((p) => p.invoiceId === invoice.id && p.type !== 'Deposit Refund')
    .reduce((sum, p) => sum + toNumber(p.amount), 0);
  return paid > 0;
}
