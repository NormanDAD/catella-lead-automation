#!/usr/bin/env node
/**
 * Trouve, parmi plusieurs secrets d'app Meta, celui qui detient META_WHATSAPP_TOKEN.
 *
 * Les secrets ne sont jamais affiches ni ecrits sur disque : ils sont lus depuis
 * l'environnement, servent a calculer les HMAC, et seul l'App ID gagnant est montre.
 *
 * Usage (dans TON terminal) :
 *   META_APP_SECRETS="id1:secret1,id2:secret2,..." node scripts/find-meta-app-secret.js
 */
const crypto = require('crypto');
const { execSync } = require('child_process');

const raw = process.env.META_APP_SECRETS;
if (!raw) {
  console.error('META_APP_SECRETS manquant. Format : "appId:secret,appId:secret"');
  process.exit(1);
}
const pairs = raw.split(',').map(s => s.trim()).filter(Boolean).map(p => {
  const i = p.indexOf(':');
  return { appId: p.slice(0, i).trim(), secret: p.slice(i + 1).trim() };
});

let token = process.env.META_WHATSAPP_TOKEN;
if (!token) {
  const vars = JSON.parse(execSync('railway variables --json', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
  token = vars.META_WHATSAPP_TOKEN;
  console.log('Token recupere depuis Railway.\n');
}

(async () => {
  for (const { appId, secret } of pairs) {
    const proof = crypto.createHmac('sha256', secret).update(token).digest('hex');
    const url = `https://graph.facebook.com/v21.0/debug_token`
              + `?input_token=${encodeURIComponent(token)}`
              + `&access_token=${encodeURIComponent(token)}`
              + `&appsecret_proof=${proof}`;
    let d;
    try { d = await (await fetch(url)).json(); }
    catch (e) { console.log(`${appId} : echec reseau (${e.message})`); continue; }

    if (d.error) { console.log(`${appId} : non`); continue; }

    const x = d.data || {};
    console.log(`\n${appId} : OUI — c'est cette app qui detient le token.\n`);
    console.log('  app      :', x.application);
    console.log('  type     :', x.type);
    console.log('  valide   :', x.is_valid);
    console.log('  expire   :', x.expires_at ? new Date(x.expires_at * 1000).toISOString() : 'jamais');
    console.log('  scopes   :', (x.scopes || []).join(', ') || '(aucun)');
    console.log(`\n  -> Mets le secret de l'app ${appId} dans Railway : META_APP_SECRET`);
    process.exit(0);
  }
  console.log('\nAucun des secrets fournis ne detient ce token.');
  process.exit(2);
})();
