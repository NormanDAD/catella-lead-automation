// Test runtime : prouve que /api/test/j15-dry-run NE déclenche AUCUN appel
// vers Power Automate ni Twilio. Test ajouté après l'incident 2026-05-15
// (mon ancien dry-run envoyait pour de vrai 100+ emails).
//
// Stratégie :
//   1. Configurer env vars de test (DATA_DIR isolé, ports mockés)
//   2. Monkey-patch global.fetch pour intercepter tout call sortant
//   3. require server.js (boot serveur sur port 19990)
//   4. Hit /api/test/j15-dry-run
//   5. Assert : 0 hit sur Power Automate, 0 hit sur Twilio
//
// Usage : node test-j15-dry-run-gate.js
// Exit code 0 = pass, !=0 = fail.

const fs = require('fs');
const path = require('path');

// ── Config env vars AVANT require server.js ─────────────────────────────────
const TEST_PORT = 19990;
process.env.PORT = String(TEST_PORT);
process.env.DATA_DIR = '/tmp/j15-test-data';
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
process.env.WHATSAPP_J15_ENABLED = 'true';
process.env.TWILIO_TEMPLATE_RELANCE_J15 = 'HXtest';
process.env.TWILIO_TEMPLATE_RELANCE_J1 = 'HXtest1';
process.env.J15_ENABLED = 'true';
process.env.J15_DELAY_DAYS = '15';
process.env.J15_CRON_HOUR_PARIS = '25'; // valeur invalide → cron ne fire jamais
process.env.J15_SEND_DISABLED = 'false';
process.env.PIPELINE_DISABLED = 'true'; // bloque schedulerTick J+1
process.env.TELEGRAM_NOTIF_ENABLED = 'false';
process.env.SKIP_REGISTRATIONS_CHECK = 'true';
process.env.REPLY_HANDLER_ENABLED = 'false';

// ── Fixture data ────────────────────────────────────────────────────────────
const dir = process.env.DATA_DIR;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pending_leads.json'), '[]');
fs.writeFileSync(path.join(dir, 'processed_leads.json'), JSON.stringify([
  // Candidat OK (programName résolu) — devrait être "would-have-sent"
  {
    interestId: 1001, leadId: 999, programId: 611, programName: 'Cristallerie',
    status: 'sent', receivedAt: '2026-01-01T00:00:00Z', processedAt: '2026-01-02T00:00:00Z',
    email: 'test@example.com', contactName: 'Test User',
  },
  // Candidat BAD-NAME — mon fix doit le skip
  {
    interestId: 1002, leadId: 998, programId: 999, programName: 'Programme #999',
    status: 'sent', receivedAt: '2026-01-01T00:00:00Z', processedAt: '2026-01-02T00:00:00Z',
    email: 'test2@example.com', contactName: 'Test User 2',
  },
]));

// ── Monkey-patch fetch — intercepte TOUS les outbound calls ─────────────────
const outboundCalls = { powerAutomate: 0, twilio: 0, telegram: 0 };
const originalFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);

  if (u.includes('api.twilio.com')) {
    outboundCalls.twilio++;
    console.log('[TEST WARN] Twilio call:', u);
    return new Response(JSON.stringify({ sid: 'SMtest' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('telegram.org')) {
    outboundCalls.telegram++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('test-pa.example.com')) {
    outboundCalls.powerAutomate++;
    console.log('[TEST WARN] Power Automate call:', u);
    return new Response('OK', { status: 200 });
  }
  // Adlead — canned responses
  if (u.includes('adlead-fake.example.com')) {
    if (u.match(/\/leads\/999/)) {
      return new Response(JSON.stringify({ data: {
        id: 999, status: 'pending', is_under_prescription: false,
        last_interaction_at: '2026-01-01T00:00:00Z',
        contacts: [{ email: 'test@example.com', firstname: 'Test', has_opted_out: false }],
        program: { name: 'Cristallerie' }
      }}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.match(/\/leads\/998/)) {
      return new Response(JSON.stringify({ data: {
        id: 998, status: 'pending', is_under_prescription: false,
        last_interaction_at: '2026-01-01T00:00:00Z',
        contacts: [{ email: 'test2@example.com', firstname: 'Test2', has_opted_out: false }],
        // program field absent → name resolution fails → bad-name skip
      }}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/programs/999')) {
      // fetchProgram retry — pas de name → skip "programme non résolu"
      return new Response(JSON.stringify({ data: { id: 999 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/programs/611')) {
      return new Response(JSON.stringify({ data: { id: 611, name: 'Cristallerie' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }
  // Fallback (localhost test calls)
  return originalFetch(url, opts);
};

// ── Boot server.js ──────────────────────────────────────────────────────────
require(path.resolve(__dirname, 'server.js'));

// ── Test execution ──────────────────────────────────────────────────────────
(async () => {
  await new Promise(r => setTimeout(r, 1500)); // server warmup

  console.log('\n=== Calling /api/test/j15-dry-run ===');
  const r = await fetch(`http://localhost:${TEST_PORT}/api/test/j15-dry-run`);
  const j = await r.json();
  console.log(JSON.stringify(j, null, 2));

  console.log('\n=== OUTBOUND CALLS ===');
  console.log(outboundCalls);

  console.log('\n=== ASSERTIONS ===');
  let ok = true;
  const fail = (msg) => { console.log('❌ FAIL:', msg); ok = false; };
  const pass = (msg) => console.log('✅ PASS:', msg);

  if (outboundCalls.powerAutomate === 0) pass('0 hit Power Automate');
  else fail(`Power Automate hit ${outboundCalls.powerAutomate} fois — dry-run a envoyé !`);

  if (outboundCalls.twilio === 0) pass('0 hit Twilio');
  else fail(`Twilio hit ${outboundCalls.twilio} fois — dry-run a envoyé !`);

  const lead999 = (j.results || []).find(x => x.leadId === 999);
  if (lead999 && lead999.sent && lead999.dryRun) pass('lead 999 (programName OK) marqué would-have-sent + dryRun=true');
  else fail(`lead 999 mal géré: ${JSON.stringify(lead999)}`);

  const lead998 = (j.results || []).find(x => x.leadId === 998);
  if (lead998 && lead998.skipped && String(lead998.reason || '').includes('non résolu')) pass('lead 998 (bad-name) skip avec reason "programme non résolu"');
  else fail(`lead 998 mal géré: ${JSON.stringify(lead998)}`);

  console.log(ok ? '\n✅ ALL TESTS PASSED' : '\n❌ TESTS FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
