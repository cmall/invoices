'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeTotals } = require('../src/calc');

test('line amounts, taxes on taxable lines only', () => {
  const t = computeTotals(
    [
      { quantity: 1.5, unit_price_cents: 12000, taxable: 1 },
      { quantity: 1, unit_price_cents: 5000, taxable: 0 },
    ],
    [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7 }],
  );
  assert.deepStrictEqual(t.lineAmounts, [18000, 5000]);
  assert.strictEqual(t.subtotal, 23000);
  assert.deepStrictEqual(t.taxAmounts, [900, 1260]);
  assert.strictEqual(t.total, 23000 + 900 + 1260);
});

test('discount reduces the taxable base', () => {
  const t = computeTotals([{ quantity: 10, unit_price_cents: 10000, taxable: 1 }], [{ name: 'HST', rate: 13 }], 10);
  assert.strictEqual(t.subtotal, 100000);
  assert.strictEqual(t.discount, 10000);
  assert.strictEqual(t.taxAmounts[0], 11700);
  assert.strictEqual(t.total, 100000 - 10000 + 11700);
});

test('fixed tax amounts (imported documents) are used as-is', () => {
  const t = computeTotals([{ quantity: 1, unit_price_cents: 10000 }], [{ name: 'Tax', rate: 5, fixed_amount_cents: 499 }]);
  assert.strictEqual(t.tax, 499);
  assert.strictEqual(t.total, 10499);
});

test('rounding to the cent', () => {
  const t = computeTotals([{ quantity: 0.333, unit_price_cents: 10000 }], [{ name: 'GST', rate: 5 }]);
  assert.strictEqual(t.lineAmounts[0], 3330);
  assert.strictEqual(t.taxAmounts[0], 167);
});
