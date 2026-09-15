#!/usr/bin/env node
/**
 * Identifie l'app Meta a laquelle appartient META_WHATSAPP_TOKEN, et verifie que
 * META_APP_SECRET est bien celui de cette app.
 *
 * Le secret ne quitte jamais ta machine : il est lu depuis l'environnement, sert a
 * calculer le HMAC, et n'est jamais affiche.
 *
 * Usage (dans TON terminal, pas dans une session Claude) :
 *   META_APP_SECRET=xxxxx node scripts/check-meta-token.js
 *
 * Le token est lu depuis META_WHATSAPP_TOKEN, ou a defaut recupere via `railway variables`.
 */
const crypto = require('crypto');
const { execSync } = require('child_process');

const secret = process.env.META_APP_SECRET;
if (!secret) {
  console.error('META_APP_SECRET manquant. Usage : META_APP_SECRET=xxx node scripts/check-meta-token.js');
  process.exit(1);
}

let token = process.env.META_WHATSAPP_TOKEN;
if (!token) {
  try {
    const vars = JSON.parse(execSync('railway variables --json', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
    token = vars.META_WHATSAPP_TOKEN;
    console.log('Token recupere depuis Railway.');
  } catch {
    console.error('Token introuvable : renseigne META_WHATSAPP_TOKEN ou lance depuis le repo lie a Railway.');
    process.exit(1);
  }
}

const proof = crypto.createHmac('sha256', secret).update(token).digest('hex');
const url = `https://graph.facebook.com/v21.0/debug_token`
          + `?input_token=${encodeURIComponent(token)}`
          + `&access_token=${encodeURIComponent(token)}`
          + `&appsecret_proof=${proof}`;

fetch(url).then(r => r.json()).then(d => {
  if (d.error) {
    console.error('\n❌ ' + d.error.message);
    if (/proof/i.test(d.error.message || '')) {
      console.error('   -> Le secret fourni n\'est PAS celui de l\'app qui detient ce token.');
      console.error('      Reessaie avec le secret d\'une autre app.');
    }
    process.exit(2);
  }
  const x = d.data || {};
  console.log('\n✅ Le secret correspond bien a l\'app de ce token.\n');
  console.log('  app_id   :', x.app_id);
  console.log('  app      :', x.application);
  console.log('  type     :', x.type);
  console.log('  valide   :', x.is_valid);
  console.log('  expire   :', x.expires_at ? new Date(x.expires_at * 1000).toISOString() : 'jamais');
  console.log('  scopes   :', (x.scopes || []).join(', ') || '(aucun)');
  console.log('\n  -> Mets CE secret dans Railway : META_APP_SECRET');
}).catch(e => { console.error('Echec reseau :', e.message); process.exit(3); });
