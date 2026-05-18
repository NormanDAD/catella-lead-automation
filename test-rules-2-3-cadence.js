// Test runtime des règles 2 (J+3/+4/+5) et 3 (J+15/+16/+17) refactor 2026-05-18.
// Vérifie :
//  - Trigger via `last_interaction_at` Adlead (pas pendingSince interne)
//  - Cadence per-day basée sur counter j3mRelances / j15Relances
//  - Stop sur status ≠ pending (reset counter)
//  - Statut 'j1-manual-pending' éligible (nouveau)
//  - Filtres : dénonciation, opt-out, bad-name, max counter
//  - 0 appel sortant en dry-run

const fs = require('fs');
const path = require('path');

const TEST_PORT = 19993;

process.env.PORT = String(TEST_PORT);
process.env.DATA_DIR = '/tmp/rules-2-3-test-data';
process.env.ADLEAD_API_KEY = 'test-key';
process.env.ADLEAD_API_BASE = 'https://adlead-fake.example.com/api/v1';
process.env.ADLEAD_TENANT = 'test';
process.env.ADLEAD_UI_BASE = 'https://test-ui.example.com';
process.env.ADLEAD_WEBHOOK_SECRET = 'test';
process.env.POWER_AUTOMATE_URL = 'https://test-pa.example.com/captured';
process.env.SENDER_EMAIL = 'test@catella.com';
process.env.INTERNAL_NOTIF_EMAIL = 'test@catella.com';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tokentest';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+10000000000';
process.env.WHATSAPP_ENABLED = 'true';

// Règles 2 et 3 : ENABLED + sendDisabled=false (on teste via dryRun)
process.env.J3M_ENABLED = 'true';
process.env.J3M_SEND_DISABLED = 'false';
process.env.WHATSAPP_J3M_ENABLED = 'true';
process.env.TWILIO_TEMPLATE_J3M_DAY2 = 'HXtest_j3m_day2';
process.env.J3M_CRON_HOUR_PARIS = '25';

process.env.J15_ENABLED = 'true';
process.env.J15_SEND_DISABLED = 'false';
process.env.WHATSAPP_J15_ENABLED = 'true';
process.env.TWILIO_TEMPLATE_J16 = 'HXtest_j16';
process.env.J15_CRON_HOUR_PARIS = '25';

process.env.PIPELINE_DISABLED = 'true';
process.env.TELEGRAM_NOTIF_ENABLED = 'false';
process.env.SKIP_REGISTRATIONS_CHECK = 'true';
process.env.REPLY_HANDLER_ENABLED = 'false';

// ── Fixtures ────────────────────────────────────────────────────────────────
const dir = process.env.DATA_DIR;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pending_leads.json'), '[]');
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
fs.writeFileSync(path.join(dir, 'processed_leads.json'), JSON.stringify([
  // === RÈGLE 2 (J+3/+4/+5) ===
  // (101) Day 1 : counter=0, lead.last_interaction_at=4d ago → send #1 (email doux)
  { leadId: 101, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'd1@x.com', contactName: 'A' },

  // (102) Day 2 : counter=1, last_interaction_at=5d ago → send #2 (whatsapp moyen)
  { leadId: 102, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'd2@x.com', contactName: 'B',
    j3mRelances: 1 },

  // (103) Day 3 : counter=2, last_interaction_at=6d ago → send #3 (email final)
  { leadId: 103, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'd3@x.com', contactName: 'C',
    j3mRelances: 2 },

  // (104) Trop tôt : counter=0, last_interaction_at=2d ago → skip
  { leadId: 104, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'soon@x.com', contactName: 'D' },

  // (105) Status changé : prospect a répondu (ongoing) → reset counter
  { leadId: 105, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'chg@x.com', contactName: 'E',
    j3mRelances: 1 },

  // (106) j1-manual-pending (nouveau statut, doit être éligible)
  { leadId: 106, programId: 611, programName: 'Cristallerie', status: 'j1-manual-pending',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'jmp@x.com', contactName: 'F' },

  // (107) Max atteint : j3mRelances=3 → exclu par pré-filtre
  { leadId: 107, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 10 * DAY).toISOString(), email: 'max@x.com', contactName: 'G',
    j3mRelances: 3 },

  // === RÈGLE 3 (J+15/+16/+17) ===
  // (201) Day 1 J+15 : counter=0, last_interaction_at=16d ago
  { leadId: 201, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 30 * DAY).toISOString(), email: 'j15d1@x.com', contactName: 'H' },

  // (202) Day 2 J+16 : counter=1, last_interaction_at=17d ago
  { leadId: 202, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 30 * DAY).toISOString(), email: 'j15d2@x.com', contactName: 'I',
    j15Relances: 1 },

  // (203) Day 3 J+17 : counter=2, last_interaction_at=18d ago
  { leadId: 203, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 30 * DAY).toISOString(), email: 'j15d3@x.com', contactName: 'J',
    j15Relances: 2 },

  // (204) j15 trop tôt : counter=0, last_interaction_at=10d ago → skip
  { leadId: 204, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 20 * DAY).toISOString(), email: 'j15soon@x.com', contactName: 'K' },
]));

// ── Mock fetch (Adlead retourne last_interaction_at variable selon leadId) ──
const outboundCalls = { twilio: 0, powerAutomate: 0, telegram: 0 };
const originalFetch = global.fetch;

function leadResponse(id, daysSinceLastAction, overrides = {}) {
  return new Response(JSON.stringify({ data: {
    id,
    status: overrides.status || 'pending',
    is_under_prescription: overrides.is_under_prescription || false,
    last_interaction_at: new Date(now - daysSinceLastAction * DAY).toISOString(),
    contacts: [{ email: overrides.email || `${id}@x.com`, firstname: 'Test', has_opted_out: false, phone: '+33600000000' }],
    program: overrides.program === undefined ? { name: 'Cristallerie' } : overrides.program,
  }}), { status: 200 });
}

global.fetch = async (url, opts) => {
  const u = String(url);

  if (u.includes('api.twilio.com')) {
    outboundCalls.twilio++;
    console.log('[TEST WARN] Twilio call:', u);
    return new Response(JSON.stringify({ sid: 'SMtest' }), { status: 200 });
  }
  if (u.includes('telegram.org')) {
    outboundCalls.telegram++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (u.includes('test-pa.example.com')) {
    outboundCalls.powerAutomate++;
    console.log('[TEST WARN] Power Automate call:', u);
    return new Response('OK', { status: 200 });
  }

  if (u.includes('adlead-fake.example.com')) {
    if (u.match(/\/leads\/101/)) return leadResponse(101, 4);
    if (u.match(/\/leads\/102/)) return leadResponse(102, 5);
    if (u.match(/\/leads\/103/)) return leadResponse(103, 6);
    if (u.match(/\/leads\/104/)) return leadResponse(104, 2);
    if (u.match(/\/leads\/105/)) return leadResponse(105, 5, { status: 'ongoing' });
    if (u.match(/\/leads\/106/)) return leadResponse(106, 4, { email: 'jmp@x.com' });
    // 107 = pre-filtered, not fetched
    if (u.match(/\/leads\/201/)) return leadResponse(201, 16);
    if (u.match(/\/leads\/202/)) return leadResponse(202, 17);
    if (u.match(/\/leads\/203/)) return leadResponse(203, 18);
    if (u.match(/\/leads\/204/)) return leadResponse(204, 10);
    if (u.includes('/programs/611')) return new Response(JSON.stringify({ data: { id: 611, name: 'Cristallerie' } }), { status: 200 });
    return new Response('{}', { status: 200 });
  }
  return originalFetch(url, opts);
};

// ── Boot serveur ────────────────────────────────────────────────────────────
require(path.resolve(__dirname, 'server.js'));

// ── Tests ───────────────────────────────────────────────────────────────────
(async () => {
  await new Promise(r => setTimeout(r, 1500));

  let ok = true;
  const fail = (msg) => { console.log('❌ FAIL:', msg); ok = false; };
  const pass = (msg) => console.log('✅ PASS:', msg);

  // === DRY-RUN J3M ===
  console.log('\n=== TEST règle 2 (j3m dry-run) ===');
  let r = await fetch(`http://localhost:${TEST_PORT}/api/test/j3m-dry-run`);
  let j = await r.json();
  const j3mResults = j.results || [];
  const find = (lid) => j3mResults.find(x => x.leadId === lid);

  if (find(101)?.sent && find(101)?.dayNumber === 1 && find(101)?.channel === 'email') pass('Lead 101 → j3m day 1 email (counter=0, 4d)');
  else fail(`101: ${JSON.stringify(find(101))}`);

  if (find(102)?.sent && find(102)?.dayNumber === 2 && find(102)?.channel === 'whatsapp') pass('Lead 102 → j3m day 2 whatsapp (counter=1, 5d)');
  else fail(`102: ${JSON.stringify(find(102))}`);

  if (find(103)?.sent && find(103)?.dayNumber === 3 && find(103)?.channel === 'email') pass('Lead 103 → j3m day 3 email (counter=2, 6d)');
  else fail(`103: ${JSON.stringify(find(103))}`);

  if (find(104)?.skipped && /pas de relance prévue/.test(find(104)?.reason || '')) pass('Lead 104 → skip trop tôt (counter=0, 2d)');
  else fail(`104: ${JSON.stringify(find(104))}`);

  if (find(105)?.skipped && find(105)?.reset === true) pass('Lead 105 → skip + reset sur status=ongoing');
  else fail(`105: ${JSON.stringify(find(105))}`);

  if (find(106)?.sent && find(106)?.dayNumber === 1) pass('Lead 106 (status=j1-manual-pending) → éligible et send day 1');
  else fail(`106: ${JSON.stringify(find(106))}`);

  if (!find(107)) pass('Lead 107 (counter=3) → exclu par pré-filtre');
  else fail(`107 devrait être filtré: ${JSON.stringify(find(107))}`);

  // === DRY-RUN J15 ===
  console.log('\n=== TEST règle 3 (j15 dry-run) ===');
  r = await fetch(`http://localhost:${TEST_PORT}/api/test/j15-dry-run`);
  j = await r.json();
  const j15Results = j.results || [];
  const find15 = (lid) => j15Results.find(x => x.leadId === lid);

  if (find15(201)?.sent && find15(201)?.dayNumber === 1 && find15(201)?.channel === 'email') pass('Lead 201 → j15 day 1 email (counter=0, 16d)');
  else fail(`201: ${JSON.stringify(find15(201))}`);

  if (find15(202)?.sent && find15(202)?.dayNumber === 2 && find15(202)?.channel === 'whatsapp') pass('Lead 202 → j15 day 2 whatsapp (counter=1, 17d)');
  else fail(`202: ${JSON.stringify(find15(202))}`);

  if (find15(203)?.sent && find15(203)?.dayNumber === 3 && find15(203)?.channel === 'email') pass('Lead 203 → j15 day 3 email (counter=2, 18d)');
  else fail(`203: ${JSON.stringify(find15(203))}`);

  if (find15(204)?.skipped && /pas de relance prévue/.test(find15(204)?.reason || '')) pass('Lead 204 → skip trop tôt (counter=0, 10d)');
  else fail(`204: ${JSON.stringify(find15(204))}`);

  // === GATE OUTBOUND ===
  console.log('\n=== OUTBOUND CALLS ===');
  console.log(outboundCalls);
  if (outboundCalls.twilio === 0) pass('0 hit Twilio (gate dry-run OK)');
  else fail(`Twilio ${outboundCalls.twilio}× en dry-run`);
  if (outboundCalls.powerAutomate === 0) pass('0 hit Power Automate (gate dry-run OK)');
  else fail(`Power Automate ${outboundCalls.powerAutomate}× en dry-run`);

  console.log(ok ? '\n✅ ALL TESTS PASSED' : '\n❌ TESTS FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
