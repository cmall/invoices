'use strict';

// Pure totals calculation shared by the server, PDF and tests.
//
// lines: [{ quantity, unit_price_cents, taxable }]
// taxes: [{ name, rate, fixed_amount_cents? }]
// discountPercent: applied to the subtotal before tax (it reduces the taxable base).
function computeTotals(lines, taxes, discountPercent = 0) {
  let subtotal = 0;
  let taxableSubtotal = 0;
  const lineAmounts = lines.map((l) => {
    const amount = lineAmount(l);
    subtotal += amount;
    if (l.taxable === undefined || l.taxable === null || Number(l.taxable)) taxableSubtotal += amount;
    return amount;
  });

  const pct = Math.min(Math.max(Number(discountPercent) || 0, 0), 100);
  const discount = Math.round((subtotal * pct) / 100);
  const taxableBase = taxableSubtotal - Math.round((taxableSubtotal * pct) / 100);

  const taxAmounts = taxes.map((t) =>
    t.fixed_amount_cents !== null && t.fixed_amount_cents !== undefined
      ? Number(t.fixed_amount_cents)
      : Math.round((taxableBase * (Number(t.rate) || 0)) / 100),
  );
  const tax = taxAmounts.reduce((a, b) => a + b, 0);

  return {
    lineAmounts,
    subtotal,
    discount,
    taxableBase,
    taxAmounts,
    tax,
    total: subtotal - discount + tax,
  };
}

function lineAmount(l) {
  return Math.round((Number(l.quantity) || 0) * (Number(l.unit_price_cents) || 0));
}

module.exports = { computeTotals, lineAmount };
