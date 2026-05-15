// Test runtime de la règle J+3 matin.
// Vérifie :
//  1. /api/test/j3m-dry-run NE déclenche AUCUN appel sortant Power Automate / Twilio
//  2. La logique day1/day2/day3 calcule le bon jour selon j3mRelances
//  3. Le filtre 24h-after-pendingSince marche
//  4. Reset sur status≠pending fonctionne
//  5. Bad-name programme → skip
//  6. is_under_prescription=true → skip
//  7. Email manquant → skip
//  8. Max 3 relances → pré-filtre
//
// Usage : node test-j3m-dry-run-gate.js
// Exit 0 = pass, !=0 = fail.

const fs = require('fs');
const path = require('path');

// ── Config env vars AVANT require server.js ─────────────────────────────────
const TEST_PORT = 19991;
process.env.PORT = String(TEST_PORT);
process.env.DATA_DIR = '/tmp/j3m-test-data';
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
process.env.J3M_ENABLED = 'true';                  // tick possible mais...
process.env.J3M_SEND_DISABLED = 'false';            // ...on teste avec sendDisabled=false pour valider le gate dryRun
process.env.WHATSAPP_J3M_ENABLED = 'true';
process.env.TWILIO_TEMPLATE_J3M_DAY2 = 'HXtest_j3m_day2';
process.env.J3M_CRON_HOUR_PARIS = '25';            // jamais → bloque l'auto-tick
process.env.PIPELINE_DISABLED = 'true';
process.env.TELEGRAM_NOTIF_ENABLED = 'false';
process.env.SKIP_REGISTRATIONS_CHECK = 'true';
process.env.REPLY_HANDLER_ENABLED = 'false';
process.env.J15_ENABLED = 'false';                  // pas de tick J+15 en parallèle
process.env.J15_CRON_HOUR_PARIS = '25';

// ── Fixture data : 8 leads couvrant tous les cas critiques ──────────────────
const dir = process.env.DATA_DIR;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pending_leads.json'), '[]');
const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
fs.writeFileSync(path.join(dir, 'processed_leads.json'), JSON.stringify([
  // (1) FIRST DETECTION : status=pending, pendingSince null → on doit poser pendingSince, pas envoyer
  { leadId: 101, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 3*DAY).toISOString(), email: 'first@example.com', contactName: 'A' },

  // (2) DAY 1 : pendingSince > 24h, j3mRelances=0 → envoi day 1 (email "doux")
  { leadId: 102, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 5*DAY).toISOString(), email: 'day1@example.com', contactName: 'B',
    pendingSince: new Date(now - 30*HOUR).toISOString(), j3mRelances: 0 },

  // (3) DAY 2 : pendingSince > 24h, j3mRelances=1 → envoi day 2 (WhatsApp template ou fallback)
  { leadId: 103, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 5*DAY).toISOString(), email: 'day2@example.com', contactName: 'C',
    pendingSince: new Date(now - 50*HOUR).toISOString(), j3mRelances: 1 },

  // (4) DAY 3 : pendingSince > 24h, j3mRelances=2 → envoi day 3 (email "final")
  { leadId: 104, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 5*DAY).toISOString(), email: 'day3@example.com', contactName: 'D',
    pendingSince: new Date(now - 80*HOUR).toISOString(), j3mRelances: 2 },

  // (5) TOO SOON : pendingSince < 24h → skip
  { leadId: 105, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 2*DAY).toISOString(), email: 'soon@example.com', contactName: 'E',
    pendingSince: new Date(now - 10*HOUR).toISOString(), j3mRelances: 0 },

  // (6) STATUS CHANGED : prospect a bougé → reset + skip
  { leadId: 106, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 4*DAY).toISOString(), email: 'changed@example.com', contactName: 'F',
    pendingSince: new Date(now - 40*HOUR).toISOString(), j3mRelances: 1 },

  // (7) BAD NAME : status=pending mais programName="Programme #998" → skip
  { leadId: 107, programId: 998, programName: 'Programme #998', status: 'sent',
    receivedAt: new Date(now - 5*DAY).toISOString(), email: 'badname@example.com', contactName: 'G',
    pendingSince: new Date(now - 30*HOUR).toISOString(), j3mRelances: 0 },

  // (8) DENOUNCED : is_under_prescription=true (sera renvoyé par mock) → skip
  { leadId: 108, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 5*DAY).toISOString(), email: 'denounced@example.com', contactName: 'H',
    pendingSince: new Date(now - 30*HOUR).toISOString(), j3mRelances: 0 },

  // (9) MAX REACHED : j3mRelances=3 → pré-filtre exclut
  { leadId: 109, programId: 611, programName: 'Cristallerie', status: 'sent',
    receivedAt: new Date(now - 8*DAY).toISOString(), email: 'maxed@example.com', contactName: 'I',
    pendingSince: new Date(now - 5*DAY).toISOString(), j3mRelances: 3 },
]));

// ── Monkey-patch fetch ──────────────────────────────────────────────────────
const outboundCalls = { powerAutomate: 0, twilio: 0, telegram: 0 };
const originalFetch = global.fetch;
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

  // Adlead canned responses
  if (u.includes('adlead-fake.example.com')) {
    // Helper : build a "lead" response.
    const lead = (overrides) => new Response(JSON.stringify({ data: {
      id: overrides.id, status: overrides.status || 'pending',
      is_under_prescription: overrides.is_under_prescription || false,
      last_interaction_at: '2026-01-01T00:00:00Z',
      contacts: overrides.contacts || [{ email: overrides.email || 'test@example.com', firstname: 'Test', has_opted_out: false, phone: '+33600000000' }],
      program: overrides.program === undefined ? { name: 'Cristallerie' } : overrides.program,
    }}), { status: 200 });

    if (u.match(/\/leads\/101/)) return lead({ id: 101, email: 'first@example.com' });
    if (u.match(/\/leads\/102/)) return lead({ id: 102, email: 'day1@example.com' });
    if (u.match(/\/leads\/103/)) return lead({ id: 103, email: 'day2@example.com' });
    if (u.match(/\/leads\/104/)) return lead({ id: 104, email: 'day3@example.com' });
    if (u.match(/\/leads\/105/)) return lead({ id: 105, email: 'soon@example.com' });
    if (u.match(/\/leads\/106/)) return lead({ id: 106, email: 'changed@example.com', status: 'ongoing' });
    if (u.match(/\/leads\/107/)) return lead({ id: 107, email: 'badname@example.com', program: null });
    if (u.match(/\/leads\/108/)) return lead({ id: 108, email: 'denounced@example.com', is_under_prescription: true });
    if (u.match(/\/leads\/109/)) return lead({ id: 109, email: 'maxed@example.com' });

    if (u.includes('/programs/998')) {
      return new Response(JSON.stringify({ data: { id: 998 } }), { status: 200 }); // pas de name → bad-name skip
    }
    if (u.includes('/programs/611')) {
      return new Response(JSON.stringify({ data: { id: 611, name: 'Cristallerie' } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }
  return originalFetch(url, opts);
};

// ── Boot server.js ──────────────────────────────────────────────────────────
require(path.resolve(__dirname, 'server.js'));

// ── Test execution ──────────────────────────────────────────────────────────
(async () => {
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n=== Calling /api/test/j3m-dry-run ===');
  const r = await fetch(`http://localhost:${TEST_PORT}/api/test/j3m-dry-run`);
  const j = await r.json();
  console.log(JSON.stringify(j, null, 2));

  console.log('\n=== OUTBOUND CALLS ===');
  console.log(outboundCalls);

  console.log('\n=== ASSERTIONS ===');
  let ok = true;
  const fail = (msg) => { console.log('❌ FAIL:', msg); ok = false; };
  const pass = (msg) => console.log('✅ PASS:', msg);
  const find = (lid) => (j.results || []).find(x => x.leadId === lid);

  if (outboundCalls.powerAutomate === 0) pass('0 hit Power Automate (gate dry-run OK)');
  else fail(`Power Automate appelé ${outboundCalls.powerAutomate}× en dry-run`);

  if (outboundCalls.twilio === 0) pass('0 hit Twilio (gate dry-run OK)');
  else fail(`Twilio appelé ${outboundCalls.twilio}× en dry-run`);

  // (1) First detection
  const r1 = find(101);
  if (r1 && r1.skipped && String(r1.reason||'').includes('première détection')) pass('Lead 101 first-detection → pendingSince noté, pas envoi');
  else fail(`Lead 101 mal géré: ${JSON.stringify(r1)}`);

  // (2) Day 1
  const r2 = find(102);
  if (r2 && r2.sent && r2.dayNumber === 1 && r2.channel === 'email' && r2.dryRun === true) pass('Lead 102 → day 1 email');
  else fail(`Lead 102 day1 mal géré: ${JSON.stringify(r2)}`);

  // (3) Day 2 (WhatsApp ou fallback selon config)
  const r3 = find(103);
  if (r3 && r3.sent && r3.dayNumber === 2 && (r3.channel === 'whatsapp' || r3.channel === 'email-fallback')) pass(`Lead 103 → day 2 (${r3.channel})`);
  else fail(`Lead 103 day2 mal géré: ${JSON.stringify(r3)}`);

  // (4) Day 3
  const r4 = find(104);
  if (r4 && r4.sent && r4.dayNumber === 3 && r4.channel === 'email') pass('Lead 104 → day 3 email final');
  else fail(`Lead 104 day3 mal géré: ${JSON.stringify(r4)}`);

  // (5) Too soon
  const r5 = find(105);
  if (r5 && r5.skipped && String(r5.reason||'').includes('attente 24h')) pass('Lead 105 → skip <24h');
  else fail(`Lead 105 mal géré: ${JSON.stringify(r5)}`);

  // (6) Status changed → reset
  const r6 = find(106);
  if (r6 && r6.skipped && r6.reset === true && String(r6.reason||'').includes('ongoing')) pass('Lead 106 → reset sur status≠pending');
  else fail(`Lead 106 mal géré: ${JSON.stringify(r6)}`);

  // (7) Bad name → skip
  const r7 = find(107);
  if (r7 && r7.skipped && String(r7.reason||'').includes('non résolu')) pass('Lead 107 → skip bad-name');
  else fail(`Lead 107 mal géré: ${JSON.stringify(r7)}`);

  // (8) Denounced → skip
  const r8 = find(108);
  if (r8 && r8.skipped && String(r8.reason||'').includes('is_under_prescription')) pass('Lead 108 → skip dénonciation');
  else fail(`Lead 108 mal géré: ${JSON.stringify(r8)}`);

  // (9) Max reached → pas dans la liste (pré-filtre)
  const r9 = find(109);
  if (!r9) pass('Lead 109 (j3mRelances=3) → exclu par pré-filtre');
  else fail(`Lead 109 devrait être filtré: ${JSON.stringify(r9)}`);

  console.log(ok ? '\n✅ ALL TESTS PASSED' : '\n❌ TESTS FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
