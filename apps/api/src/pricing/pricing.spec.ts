import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from './pricing';

const t = { baseRub: 300, perKgRub: 40 };

test('лёгкая посылка: оплата по базовой цене', () => {
  assert.equal(quote({ weightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10 }, t).totalRub, 300);
});

test('большая лёгкая коробка: считается объёмный вес', () => {
  const q = quote({ weightKg: 2, lengthCm: 60, widthCm: 40, heightCm: 40 }, t);
  assert.equal(q.volumetricKg, 19.2);
  assert.equal(q.chargeableKg, 19.2);
  assert.equal(q.totalRub, 300 + 19 * 40);
});

test('тяжёлая компактная посылка: считается фактический вес', () => {
  const q = quote({ weightKg: 10, lengthCm: 30, widthCm: 20, heightCm: 10 }, t);
  assert.equal(q.chargeableKg, 10);
  assert.equal(q.totalRub, 300 + 9 * 40);
});
