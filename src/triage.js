'use strict';

/**
 * Priority + category triage.
 *
 * This encodes the same rubric as the "support-ticket-priority-triage"
 * skill and the earlier downloadable Routing Desk tool:
 *
 *   P1 - complete service outage, data corruption, total authentication
 *        failure, or zero ability to execute primary transactions (also
 *        used for a live security/financial-accuracy exposure - e.g.
 *        real unauthorized or duplicate charges - even if it doesn't
 *        literally match those four clauses)
 *   P2 - a core feature is degraded for some customers but a temporary
 *        workaround exists
 *   P3 - how-to questions, UI confusion, minor bugs with workarounds,
 *        billing inquiries, password resets, export failures (the
 *        default - most tickets land here, matching the skill's own
 *        expected ~75% mix)
 *
 * The rule-based path below always runs and always works with zero
 * external calls. If ANTHROPIC_API_KEY is set in the server environment,
 * classifyWithAI() is available as a smarter, optional upgrade - the key
 * lives only on the server now, never in a browser, so this is safe to
 * use even during a public demo.
 */

const DEFAULT_CATEGORIES = [
  {
    name: 'Accounting/ERP Integrations',
    defaultQueue: 'Integrations L2',
    keywords: ['accounting', 'allocate', 'attachment', 'batch', 'bill pay', 'chart of accounts', 'class', 'closed period', 'coa', 'cross-entity', 'csv', 'custom field', 'debit', 'dimension', 'disconnected', 'dropdown', 'dropped', 'duplicate entry', 'employee payment', 'erp', 'exchange rate', 'exempt', 'expire', 'fraction', 'gst', 'intacct', 'intercompany', 'journal entry', 'line item', 'location', 'mapped', 'mapping', 'netsuite', 'oauth', 'out of balance', 'parent', 'previous month', 'qbo', 'quickbooks', 'record', 'rejection', 'reversal', 'sage', 'subsidiary', 'suspense']
  },
  {
    name: 'Accounts Payable/Bill Pay',
    defaultQueue: 'AP Support',
    keywords: ['1099', '2-way', '2/10 net 30', '3-way', 'ach return', 'bank details', 'bill approval', 'bounced', 'cancel', 'check', 'collect', 'contractor', 'correspondent', 'credit note', 'cut off', 'dba', 'delivery', 'discount', 'early pay', 'empty', 'identical', 'incomplete', 'incorrect account', 'installment', 'intercept', 'invoice', 'lines', 'matching', 'multi-page', 'offset', 'onboard', 'parse', 'partial', 'purchase order', 'reconcile', 'refund', 'remittance', 'route', 'routing', 'scheduled', 'short', 'split payment', 'stalled', 'stop payment', 'tax form']
  },
  {
    name: 'Card Controls & Issuing',
    defaultQueue: 'Card Ops',
    keywords: ['3ds', 'activate', 'alert', 'apple pay', 'billing', 'blocked category', 'cap', 'cardholder', 'company limit', 'compromised', 'credit limit', 'cross-border', 'cvc', 'emergency', 'flight', 'fraud', 'freeze', 'google pay', 'hotel', 'insufficient', 'large purchase', 'legal', 'maxed', 'maxed out', 'mcc', 'merchant', 'midnight', 'monthly limit', 'new card', 'override', 'overseas', 'physical card', 'pre-auth', 'recurring', 'replace', 'request', 'rollover', 'saas', 'secure', 'shipping', 'single transaction', 'software', 'specific', 'spend limit', 'stolen']
  },
  {
    name: 'Expense Management & Receipts',
    defaultQueue: 'Support Tier 1',
    keywords: ['accidental', 'alcohol', 'allocation', 'allowance', 'attach', 'auto-lock', 'bottleneck', 'bounce', 'bulk', 'calculate', 'chargeback', 'corrupted', 'crash', 'daily rate', 'delegate', 'direct deposit', 'dispute', 'distribute', 'enforce', 'euros', 'extract', 'grace period', 'gratuity', 'incorrect', 'jpeg', 'locked out', 'mileage', 'misread', 'missing receipt', 'old transaction', 'ooo', 'out of office', 'penalty', 'per diem', 'personal', 'picture', 'previous', 'rate', 'receipts@', 'repay', 'requirement', 'retroactive', 'review', 'scan', 'scanner']
  },
  {
    name: 'User Governance/Admin',
    defaultQueue: 'Admin Support',
    keywords: ['accountant', 'active card', 'analytics', 'api', 'applied', 'audit log', 'billing cycle', 'biometric', 'bookkeeper', 'cashback', 'closing date', 'compliance', 'conflict', 'cpa', 'custom role', 'dashboard', 'developer', 'disconnect', 'discrepancy', 'download', 'external', 'faceid', 'founder', 'generate', 'gusto', 'handoff', 'hierarchy', 'hris', 'identity', 'invite', 'limit increase', 'login', 'matrix', 'month end', 'move', 'offboard', 'okta', 'org chart', 'overriding', 'owner', 'permissions', 'plaid', 'preference', 'rbac', 're-evaluate']
  }
];

/* The queues these categories actually route to. Note that queue is NOT a
   function of category: "Card Controls & Issuing" splits between Card Ops
   and Risk, because a stolen card and a spend-limit question are the same
   category but different teams. That judgment is the main thing the AI
   path adds over a lookup table. */
const QUEUES = [
  { name: 'Integrations L1', when: 'Routine ERP sync problems with a known self-service fix: mapping errors, chart-of-accounts refreshes, class/department sync drops.' },
  { name: 'Integrations L2', when: 'ERP connection or configuration failures needing engineering-adjacent help: expired tokens, missing custom fields, dimension mismatches, FX sync, vendor duplication.' },
  { name: 'Integrations L3', when: 'Deep multi-entity or double-entry ledger problems: intercompany rejections, journal entries out of balance.' },
  { name: 'Accounting Support', when: 'The books themselves are wrong or blocked: closed-period rejections, uncategorized/suspense defaulting, split coding failures, manual export formatting.' },
  { name: 'AP Support', when: 'Anything about paying a bill or a person: invoices, OCR parsing, vendor payments, ACH/check delivery, reimbursements, remittance, payment terms.' },
  { name: 'Card Ops', when: 'Card behaviour working roughly as designed or needing operational action: MCC declines, spend/transaction limits, pre-auth failures, card issuing and replacement.' },
  { name: 'Risk', when: 'Fraud, security and credit exposure: stolen or compromised cards, suspicious-activity freezes, disputes, 3D Secure blocks, company credit limit reached, terminated-employee access.' },
  { name: 'Support Tier 1', when: 'Straightforward front-line requests: physical card shipping/activation, wallet tokenization, OCR extraction errors, general receipt questions.' },
  { name: 'Admin Support', when: 'Workspace administration and policy: approvals and approvers, permissions and roles, SSO/HRIS, offboarding, notification and policy settings, receipt-policy locks.' }
];

const QUEUE_NAMES = QUEUES.map((q) => q.name);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultQueueForCategory(categoryName, categories) {
  const cats = categories && categories.length ? categories : DEFAULT_CATEGORIES;
  const hit = cats.find((c) => c.name === categoryName);
  return (hit && hit.defaultQueue) || 'Support Tier 1';
}

function scoreCategories(text, categories) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  const cats = categories && categories.length ? categories : DEFAULT_CATEGORIES;
  let best = null;
  let bestScore = 0;
  for (const c of cats) {
    let score = 0;
    for (const kw of c.keywords || []) {
      if (!kw) continue;
      const m = t.match(new RegExp(escapeRe(kw), 'gi'));
      if (m) score += m.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c.name;
    }
  }
  return best;
}

const PRIORITY_RULES = {
  P1: [
    'complete outage', 'total outage', 'entire platform is down', 'platform is down for everyone',
    'system is down for everyone', 'down for everyone', 'down for all', "can't log in at all",
    'no one can log in', 'nobody can log in', 'all users are locked out', 'everyone is locked out',
    'all customers', 'data corrupt', 'data loss', 'lost data', 'database is corrupt',
    'security breach', 'breached', 'unauthorized charge', 'unauthorized charges', 'duplicate charge',
    'double charged', 'double-charged', 'fraudulent charge', "can't process any", 'zero orders',
    'nothing is working', 'completely down', 'totally down', 'total authentication failure',
    "can't complete any purchase", 'no one can complete a purchase', 'nobody can complete a purchase'
  ],
  P2: [
    'degraded', 'some customers', 'some users', 'intermittent', 'sync delayed', 'delayed sync',
    'dashboard is down', 'reporting is down', 'reporting dashboard down', 'slow to load',
    'partially working', 'workaround', 'payments failing for some', 'integration is failing for some',
    'syncing delayed', 'looping', 'redirect loop',
    // A blocked-but-scoped workflow: the customer can't finish a core task,
    // but it isn't a platform-wide outage. These phrasings came out of real
    // misclassifications where the rules defaulted to P3 because no literal
    // P2 phrase appeared.
    'sync error', 'sync failed', 'failed to sync', 'not syncing', 'stuck in',
    'stuck on', 'error state', 'keeps failing', 'failing for', 'unable to complete',
    "won't let me", 'wont let me', "can't push", 'cannot push', "can't submit",
    'cannot submit', "can't process", 'blocked from', 'not going through'
  ],
  P3: [
    'how do i', 'how to', 'export fail', 'export failed', 'export failure', 'password reset',
    "forgot my password", "didn't receive my reset", 'never arrived', 'billing question',
    'invoice question', 'invoice twice', 'ui is confusing', 'confusing', 'minor bug',
    "can't find", 'where is', 'question about', 'how can i'
  ]
};

function scorePriority(text) {
  const t = (text || '').toLowerCase();
  if (!t) return 'P3';
  const hit = (list) => list.some((kw) => t.includes(kw));
  if (hit(PRIORITY_RULES.P1)) return 'P1';
  if (hit(PRIORITY_RULES.P2)) return 'P2';
  return 'P3';
}

function ruleBasedTriage(text, categories) {
  const category = scoreCategories(text, categories);
  return {
    category,
    // Without a model, the best we can do for queue is the category's
    // most common destination. That's right about 60% of the time on the
    // 100-ticket sample - fine as a fallback, not good enough as the plan.
    queue: category ? defaultQueueForCategory(category, categories) : null,
    priority: scorePriority(text),
    classifiedBy: 'rules'
  };
}

/**
 * Optional AI classification. Only called when ANTHROPIC_API_KEY is set
 * on the server. Runs entirely server-side - the key is never sent to
 * the browser, which is what makes this safe to enable during a public
 * demo (unlike the old browser-only BYOK pattern in the downloadable tool).
 */
async function classifyWithAI(text, categories) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY not set on the server.');
  const model = (process.env.ANTHROPIC_MODEL || '').trim() || 'claude-haiku-4-5';
  const catNames = (categories && categories.length ? categories : DEFAULT_CATEGORIES).map((c) => c.name);

  const queueGuide = QUEUES.map((q) => `- ${q.name}: ${q.when}`).join('\n');

  const prompt = `You triage incoming support tickets for a spend-management platform (cards, expenses, bill pay, ERP integrations). Assign a category, a routing queue, and a priority tier.

CATEGORIES (pick exactly one; use "Uncategorized" only if genuinely none fit):
${catNames.length ? catNames.join('\n') : '(none defined)'}

ROUTING QUEUES (pick exactly one - the team that should actually work this):
${queueGuide}

Queue is not implied by category. "My card was stolen" and "why did my card decline at a hotel" are both card tickets, but the first is Risk and the second is Card Ops. Choose based on which team owns the fix.

PRIORITY TIERS:
- P1: complete service outage, data corruption, total authentication failure, or zero ability to execute primary transactions.
- P2: a core feature is genuinely broken or degraded, but a temporary workaround exists.
- P3: how-to questions, UI confusion, minor bugs with workarounds, billing inquiries, password resets, export failures.

Expected mix across normal volume is roughly 5% P1, 15-20% P2, 75-80% P3. That is a calibration check, not a quota - never force a ticket into a tier to hit it.

HOW TO DECIDE PRIORITY (these matter more than the tier wording):
1. Scope is the first filter. Company-wide or account-wide impact ("no one can log in", "the whole team's cards are declining") points to P1. Impact scoped to one user with a clear fix is P3 even when it feels urgent to that person - urgency to the reporter is not the same as severity.
2. An easy self-service workaround is a strong P3 signal, even when the wording sounds severe ("declining", "blocked", "failed"). If the fix is "remap this field", "post to an open period", "enable a setting", or "ask support to override", it is very likely P3.
3. P2 means a real feature is broken, not a control doing its job. Spend limits, matching-tolerance rejections and duplicate-invoice flags are the system working as designed - P3. A sync connection down, a whole batch failing to post, a dashboard materially disagreeing with the ledger, or something failing every time rather than once - P2.
4. Explicit P3 markers: how-to, export failure, billing inquiry, password reset. If the ticket asks "how do I..." or "can you...", default to P3 unless something else clearly escalates it.
5. FINANCIAL/SECURITY EXCEPTION: a ticket can outrank its literal wording when it is a live security or financial-accuracy exposure - an active card or access for someone who should have been cut off, a bug producing a materially wrong payment or invoice total, or transactions being systematically mis-recorded in a way that corrupts the books. Treat these as P1, and say in the summary that you are invoking this exception.
6. If genuinely torn between two tiers, pick the one you lean toward and note the competing tier in the summary so a human can review it.

CALIBRATION EXAMPLES:
- "Employees can't log in through Okta SSO; SAML is throwing an auth loop." -> P1, User Governance/Admin, Admin Support (company-wide total auth failure).
- "The dashboard says the company credit limit is reached; our entire team's cards are declining." -> P1, Card Controls & Issuing, Risk (company-wide zero ability to transact).
- "An employee was terminated yesterday but their card just made a purchase." -> P1, Card Controls & Issuing, Risk (exception: live security exposure).
- "The invoice reader jumbled the line items; the total is completely wrong." -> P1, Accounts Payable/Bill Pay, AP Support (exception: materially wrong payment).
- "My NetSuite connection says the token expired; nothing is syncing today." -> P2, Accounting/ERP Integrations, Integrations L2 (whole connection down, workaround is reconnecting).
- "Every time I issue a virtual card it throws a server error." -> P2, Card Controls & Issuing, Card Ops (fails every time; existing cards still work).
- "The Xero integration says the account mapping is invalid for one category." -> P3, Accounting/ERP Integrations, Integrations L1 (narrow, self-service remap).
- "I tried to buy a $2000 laptop but my transaction limit is $1000." -> P3, Card Controls & Issuing, Card Ops (control working as designed).
- "How do I invite our external CPA without giving them a card?" -> P3, User Governance/Admin, Admin Support (how-to).

Reply with ONLY a single compact JSON object (no prose, no markdown fences) in exactly this shape:
{"category":"<one of the listed categories, or Uncategorized>","queue":"<one of the listed queues>","priority":"<P1, P2, or P3>","summary":"<one or two plain sentences for a support agent: what the customer needs and, where it is a judgment call, why this tier>"}

RAW MESSAGE:
"""
${text.slice(0, 6000)}
"""`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    let msg = 'Anthropic API error ' + resp.status;
    try { msg = JSON.parse(errBody).error.message; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await resp.json();
  const textOut = (data.content || []).map((b) => b.text || '').join('').trim();
  const jsonStr = textOut.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(jsonStr);
  if (!['P1', 'P2', 'P3'].includes(parsed.priority)) parsed.priority = scorePriority(text);
  return parsed;
}

const PRIORITY_RANK = { P1: 3, P2: 2, P3: 1 };

/**
 * Full triage: always computes the rule-based result (guaranteed to
 * work with no external calls); if an AI key is configured, tries the
 * AI path and falls back to rules on any failure.
 *
 * Safety net: the AI is allowed to escalate a ticket the keyword rules
 * missed (rules are deliberately narrow, so this is common and good),
 * but it is never allowed to *downgrade* a priority the keyword rules
 * already flagged with high confidence - e.g. an exact phrase like
 * "completely down" always keeps its P1 floor even if the AI call
 * comes back less severe. Whichever signal is more urgent wins.
 */
async function triage(text, categories) {
  const rule = ruleBasedTriage(text, categories);
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
    return {
      category: rule.category,
      queue: rule.queue,
      priority: rule.priority,
      summary: null,
      classifiedBy: 'rules',
      aiError: null
    };
  }
  try {
    const ai = await classifyWithAI(text, categories);
    const catNames = (categories && categories.length ? categories : DEFAULT_CATEGORIES).map((c) => c.name);

    // Priority floor: the AI may escalate past the keyword rules but never
    // below them, so an obvious outage can't be talked down by a bad call.
    const aiIsMoreUrgent = PRIORITY_RANK[ai.priority] >= PRIORITY_RANK[rule.priority];
    const priority = aiIsMoreUrgent ? ai.priority : rule.priority;

    const category = catNames.includes(ai.category) ? ai.category : rule.category;
    // Only accept a queue the routing model actually knows about; anything
    // else falls back to the category's usual destination.
    const queue = QUEUE_NAMES.includes(ai.queue)
      ? ai.queue
      : (category ? defaultQueueForCategory(category, categories) : rule.queue);

    return {
      category,
      queue,
      priority,
      summary: ai.summary || null,
      classifiedBy: aiIsMoreUrgent ? 'ai' : 'rules (overrode a less-urgent AI result)',
      aiError: null
    };
  } catch (e) {
    return {
      category: rule.category,
      queue: rule.queue,
      priority: rule.priority,
      summary: null,
      classifiedBy: 'rules',
      aiError: e.message
    };
  }
}

module.exports = { DEFAULT_CATEGORIES, QUEUES, QUEUE_NAMES, scoreCategories, scorePriority, defaultQueueForCategory, ruleBasedTriage, classifyWithAI, triage };
