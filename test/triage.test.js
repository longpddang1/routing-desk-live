'use strict';
const assert = require('assert');
const { scorePriority, scoreCategories, ruleBasedTriage } = require('../src/triage');

function t(name, fn) {
  try { fn(); console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('triage.js tests');

t('complete outage -> P1', () => {
  assert.strictEqual(scorePriority('Our entire checkout is down for everyone, this is a complete outage.'), 'P1');
});

t('duplicate charge -> P1 (financial exposure exception)', () => {
  assert.strictEqual(scorePriority('I was double charged for my last invoice, please help.'), 'P1');
});

t('degraded for some customers -> P2', () => {
  assert.strictEqual(scorePriority('Payments are failing for some customers, but a workaround exists.'), 'P2');
});

t('how-to question -> P3', () => {
  assert.strictEqual(scorePriority('How do I export my order history to CSV?'), 'P3');
});

t('empty text -> P3 default', () => {
  assert.strictEqual(scorePriority(''), 'P3');
});

t('billing keyword -> Billing & Payments category', () => {
  assert.strictEqual(scoreCategories('My invoice shows a duplicate charge this month.', null), 'Billing & Payments');
});

t('ruleBasedTriage returns category + priority + classifiedBy', () => {
  const r = ruleBasedTriage('Password reset email never arrived.', null);
  assert.strictEqual(r.priority, 'P3');
  assert.strictEqual(r.classifiedBy, 'rules');
  assert.ok(r.category);
});

console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
