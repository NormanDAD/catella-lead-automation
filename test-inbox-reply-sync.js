// Test runtime du refactor /webhook/inbox-reply.
// Vérifie :
//  1. Match prospect → réponse 200 SYNC avec draft.html, draft.to, draft.subject
//  2. No-match → réponse 200 matched:false (sans draft)
//  3. Échec Claude (mock 400 credit) → fallback stub draft (PA ne casse pas)
//  4. Aucun appel Twilio (Twilio = 0)
//  5. La réponse contient TOUT ce qu'il faut pour que PA crée le draft Outlook

const fs = require('fs');
const path = require('path');

const TEST_PORT = 19992;
const PA_SECRET = 'test-pa-secret-xyz';

process.env.PORT = String(TEST_PORT);
process.env.DATA_DIR = '/tmp/inbox-reply-test-data';
process.env.ADLEAD_API_KEY = 'test-key';
process.env.ADLEAD_API_BASE = 'https://adlead-fake.example.com/api/v1';
process.env.ADLEAD_TENANT = 'test';
process.env.ADLEAD_UI_BASE = 'https://test-ui.example.com';
process.env.ADLEAD_WEBHOOK_SECRET = 'test';
process.env.POWER_AUTOMATE_URL = 'https://test-pa.example.com/captured';
process.env.POWER_AUTOMATE_INBOX_SECRET = PA_SECRET;
process.env.SENDER_EMAIL = 'norman.dadon@catella.com';
process.env.INTERNAL_NOTIF_EMAIL = 'norman.dadon@gmail.com';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tokentest';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+10000000000';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PIPELINE_DISABLED = 'true';
process.env.TELEGRAM_NOTIF_ENABLED = 'false';
process.env.SKIP_REGISTRATIONS_CHECK = 'true';
process.env.REPLY_HANDLER_ENABLED = 'false';
process.env.REPLY_NOTIF_ENABLED = 'false';        // pas de digest async pendant le test
process.env.J15_ENABLED = 'false';
process.env.J15_CRON_HOUR_PARIS = '25';
process.env.J3M_ENABLED = 'false';
process.env.J3M_CRON_HOUR_PARIS = '25';

// ── Fixtures ────────────────────────────────────────────────────────────────
const dir = process.env.DATA_DIR;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pending_leads.json'), '[]');
fs.writeFileSync(path.join(dir, 'processed_leads.json'), '[]');
// La relance trackée que /webhook/inbox-reply doit retrouver via matchReplyToRelance
fs.writeFileSync(path.join(dir, 'relance_tracking.json'), JSON.stringify([
  {
    leadId: 1639255,
    programId: 586,
    contactEmail: 'moutahir.hicham@outlook.fr',
    contactName: 'Hicham Moutahir',
    programName: 'Les Terrasses de la Bièvre',
    subject: 'Votre projet à Gentilly — quelques précisions sur « Les Terrasses de la Bièvre »',
    subjectNormalized: 'votre projet à gentilly — quelques précisions sur « les terrasses de la bièvre »',
    sentAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  }
]));

// ── Mocks fetch ─────────────────────────────────────────────────────────────
const outboundCalls = { twilio: 0, anthropic: 0, powerAutomate: 0, adlead: 0 };
const originalFetch = global.fetch;

let anthropicMode = 'success'; // 'success' | 'credit-low'

global.fetch = async (url, opts) => {
  const u = String(url);

  if (u.includes('api.twilio.com')) {
    outboundCalls.twilio++;
    console.log('[TEST WARN] Twilio call (should not happen):', u);
    return new Response('{}', { status: 200 });
  }

  if (u.includes('api.anthropic.com')) {
    outboundCalls.anthropic++;
    if (anthropicMode === 'credit-low') {
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' }
      }), { status: 400 });
    }
    // Mock un retour Claude valide. La requête a un system+user prompt — on regarde
    // si c'est un classify (renvoie JSON) ou un draft (renvoie texte).
    const reqBody = JSON.parse(opts.body || '{}');
    const userMsg = (reqBody.messages || [])[0]?.content || '';
    const isDraft = /draft|rédige|brouillon/i.test(userMsg) || /draft|rédige|brouillon/i.test(reqBody.system || '');
    let content;
    if (isDraft) {
      content = '<p>Bonjour Hicham Moutahir,</p><p>Merci pour votre message. Je vous propose qu\'on échange par téléphone cette semaine.</p><p>Bien à vous,</p>';
    } else {
      content = JSON.stringify({
        category: 'rdv',
        confidence: 'high',
        reasoning: 'Le prospect demande à visiter le programme la semaine prochaine.',
        extracted: { wantsRDV: true, sentiment: 'positif' }
      });
    }
    return new Response(JSON.stringify({
      id: 'msg_test',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }), { status: 200 });
  }

  if (u.includes('test-pa.example.com')) {
    outboundCalls.powerAutomate++;
    return new Response('OK', { status: 200 });
  }

  if (u.includes('adlead-fake.example.com')) {
    outboundCalls.adlead++;
    return new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 });
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

  // ── Test 1 : match + Claude success → response complète avec draft ─────────
  console.log('\n=== TEST 1 : match + Claude success ===');
  anthropicMode = 'success';
  outboundCalls.twilio = 0; outboundCalls.anthropic = 0;
  let r = await fetch(`http://localhost:${TEST_PORT}/webhook/inbox-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PA-Secret': PA_SECRET },
    body: JSON.stringify({
      from: 'moutahir.hicham@outlook.fr',
      fromName: 'Hicham Moutahir',
      subject: 'RE: Votre projet à Gentilly — quelques précisions sur « Les Terrasses de la Bièvre »',
      body: 'Bonjour Norman, oui je suis intéressé. Pouvez-vous m\'envoyer les plans pour un T3 ? Visite la semaine prochaine ?',
      bodyContentType: 'text',
      messageId: 'AAMkA-test-msg-123',
      conversationId: 'AAQk-test-conv-456',
    })
  });
  let j = await r.json();
  console.log('HTTP', r.status, '— response keys:', Object.keys(j));

  if (r.status === 200) pass('HTTP 200'); else fail(`HTTP ${r.status}`);
  if (j.matched === 'true') pass('matched=true'); else fail(`matched=${j.matched}`);
  if (j.leadId === 1639255) pass('leadId=1639255'); else fail(`leadId=${j.leadId}`);
  if (j.programName === 'Les Terrasses de la Bièvre') pass('programName OK'); else fail(`programName=${j.programName}`);
  if (j.classification?.category === 'rdv') pass('classification.category=rdv'); else fail(`category=${j.classification?.category}`);
  if (j.draft?.to === 'moutahir.hicham@outlook.fr') pass('draft.to OK'); else fail(`draft.to=${j.draft?.to}`);
  if (/^re\s*:/i.test(j.draft?.subject || '')) pass(`draft.subject est une réponse (${j.draft.subject.slice(0, 60)})`); else fail(`draft.subject=${j.draft?.subject}`);
  if (j.draft?.html?.includes('Norman DADON') || j.draft?.html?.includes('Norman')) pass('draft.html contient signature Norman'); else fail('draft.html sans signature');
  if (j.draft?.html?.length > 50) pass(`draft.html non vide (${j.draft.html.length} chars)`); else fail('draft.html trop court');
  if (outboundCalls.twilio === 0) pass('0 hit Twilio'); else fail(`Twilio appelé ${outboundCalls.twilio}×`);
  if (outboundCalls.anthropic === 2) pass('Anthropic appelé 2× (classify + draft)'); else fail(`anthropic=${outboundCalls.anthropic}× (attendu 2)`);

  // ── Test 2 : no-match (email inconnu) → matched:false sans draft ───────────
  console.log('\n=== TEST 2 : no match ===');
  outboundCalls.twilio = 0; outboundCalls.anthropic = 0;
  r = await fetch(`http://localhost:${TEST_PORT}/webhook/inbox-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PA-Secret': PA_SECRET },
    body: JSON.stringify({
      from: 'random@stranger.com',
      subject: 'Hello',
      body: 'Spam?',
    })
  });
  j = await r.json();
  if (r.status === 200 && j.matched === 'false') pass('No-match → matched:false');
  else fail(`HTTP ${r.status} matched=${j.matched}`);
  if (!j.draft) pass('Pas de draft en no-match'); else fail('draft présent en no-match');
  if (outboundCalls.anthropic === 0) pass('Anthropic non appelé (skip avant Claude)'); else fail(`anthropic=${outboundCalls.anthropic} en no-match`);

  // ── Test 3 : Claude échoue (credit low) → fallback stub ────────────────────
  console.log('\n=== TEST 3 : Claude credit low → fallback stub ===');
  anthropicMode = 'credit-low';
  outboundCalls.twilio = 0; outboundCalls.anthropic = 0;
  r = await fetch(`http://localhost:${TEST_PORT}/webhook/inbox-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PA-Secret': PA_SECRET },
    body: JSON.stringify({
      from: 'moutahir.hicham@outlook.fr',
      fromName: 'Hicham Moutahir',
      subject: 'RE: Votre projet à Gentilly — quelques précisions sur « Les Terrasses de la Bièvre »',
      body: 'Encore une question',
    })
  });
  j = await r.json();
  if (r.status === 200) pass('HTTP 200 même avec Claude KO');
  else fail(`HTTP ${r.status} avec Claude KO`);
  if (j.matched === 'true') pass('matched=true même avec Claude KO');
  else fail(`matched=${j.matched} avec Claude KO`);
  if (j.draft?.html?.length > 50) pass(`fallback draft non vide (${j.draft.html.length} chars)`);
  else fail('fallback draft vide');
  if (j.draft?.internalNote?.includes('échoué') || j.draft?.internalNote?.includes('erreur')) pass('internalNote alerte que Claude a échoué');
  else fail(`internalNote=${j.draft?.internalNote}`);
  if (outboundCalls.twilio === 0) pass('0 hit Twilio même avec Claude KO');
  else fail(`Twilio appelé ${outboundCalls.twilio}× avec Claude KO`);

  // ── Test 4 : Secret invalide → 401 ─────────────────────────────────────────
  console.log('\n=== TEST 4 : secret invalide → 401 ===');
  r = await fetch(`http://localhost:${TEST_PORT}/webhook/inbox-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PA-Secret': 'wrong-secret' },
    body: JSON.stringify({ from: 'x@y.com', subject: 'Test', body: 'Test' })
  });
  if (r.status === 401) pass('Secret invalide → 401');
  else fail(`Secret invalide → HTTP ${r.status}`);

  console.log(ok ? '\n✅ ALL TESTS PASSED' : '\n❌ TESTS FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
