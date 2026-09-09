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
  { name: 'Billing & Payments', keywords: ['invoice', 'billing', 'charge', 'payment', 'price'] },
  { name: 'Technical Issue', keywords: ['bug', 'error', 'broken', 'crash', 'not working', 'issue', 'loop', 'fails', 'outage', 'down'] },
  { name: 'Account Access', keywords: ['login', 'password', 'reset', 'locked out', 'sso', '2fa', 'access', 'sign in'] },
  { name: 'Product Question', keywords: ['how do i', 'how to', 'export', 'csv', 'question'] },
  { name: 'Order & Shipping', keywords: ['order', 'shipping', 'delivery', 'tracking', 'package'] },
  { name: 'Cancellation & Refund', keywords: ['cancel', 'refund', 'unsubscribe', 'downgrade', 'prorated'] }
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  return {
    category: scoreCategories(text, categories),
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

  const prompt = `You triage incoming support messages for a help desk.

Available categories: ${catNames.length ? catNames.join(', ') : '(none defined)'}. If none fit, use "Uncategorized".

Assign a priority tier using these rules:
- P1: complete service outage, data corruption, total authentication failure, or zero ability to execute primary transactions (also use P1 for a live security/financial-accuracy exposure - e.g. real unauthorized or duplicate charges hitting money - even if it doesn't literally match those four clauses).
- P2: a core feature is degraded for some customers (e.g. payments failing for some, integration sync delayed, reporting dashboard down) but a temporary workaround exists.
- P3: how-to questions, UI confusion, minor bugs with workarounds, billing inquiries, password resets, or export failures.
Most tickets are P3 - only choose P1 or P2 when the message clearly describes that level of severity.

Read the raw message below and reply with ONLY a single compact JSON object (no prose, no markdown fences) in exactly this shape:
{"category":"<one of the listed categories, or Uncategorized>","priority":"<P1, P2, or P3>","summary":"<one or two plain-language sentences describing what the customer needs, written for a support agent>"}

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
    return { category: rule.category, priority: rule.priority, summary: null, classifiedBy: 'rules', aiError: null };
  }
  try {
    const ai = await classifyWithAI(text, categories);
    const catNames = (categories && categories.length ? categories : DEFAULT_CATEGORIES).map((c) => c.name);
    const aiIsMoreUrgent = PRIORITY_RANK[ai.priority] >= PRIORITY_RANK[rule.priority];
    const priority = aiIsMoreUrgent ? ai.priority : rule.priority;
    return {
      category: catNames.includes(ai.category) ? ai.category : rule.category,
      priority,
      summary: ai.summary || null,
      classifiedBy: aiIsMoreUrgent ? 'ai' : 'rules (overrode a less-urgent AI result)',
      aiError: null
    };
  } catch (e) {
    return { category: rule.category, priority: rule.priority, summary: null, classifiedBy: 'rules', aiError: e.message };
  }
}

module.exports = { DEFAULT_CATEGORIES, scoreCategories, scorePriority, ruleBasedTriage, classifyWithAI, triage };
