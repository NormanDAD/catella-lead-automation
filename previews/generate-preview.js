// Génère un aperçu HTML du template email avec des données d'exemple
const fs = require('fs');

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailSubject(ctx) {
  return `Votre projet à ${ctx.ville} — quelques précisions sur « ${ctx.programme} »`;
}

function buildEmailBody(ctx) {
  const accrochePhrase = ctx.accroche_programme
    ? ` <em>${escapeHtml(ctx.accroche_programme)}</em> — il pourrait bien répondre à toutes vos attentes !`
    : '';

  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">
<p>Bonjour ${escapeHtml(ctx.salutation)},</p>

<p>Merci pour l'intérêt que vous portez à notre programme <strong>&laquo;&nbsp;${escapeHtml(ctx.programme)}&nbsp;&raquo;</strong> à ${escapeHtml(ctx.ville)}, proposé par ${escapeHtml(ctx.promoteur)}.${accrochePhrase}</p>

<p>Pour vous proposer les appartements les plus adaptés, j'aurais besoin de quelques précisions sur votre recherche :</p>

<ul style="margin: 8px 0 16px 0; padding-left: 22px;">
  <li>S'agit-il d'une résidence principale ou d'un investissement ?</li>
  <li>Quelle typologie recherchez-vous (T1, T2, T3…) ?</li>
  <li>Avez-vous une préférence d'étage ?</li>
  <li>Une exposition idéale ?</li>
  <li>Quel est votre budget estimé ?</li>
</ul>

<p>Dès réception de vos critères, je pourrai vous envoyer une sélection personnalisée de plans et de prix, idéale pour vous projeter dans votre futur cadre de vie.</p>

<p>👉 Vous pouvez également prendre rendez-vous en ligne avec moi à tout moment : <a href="${ctx.lien_rdv}">Réserver un créneau</a>.<br>
Ou en réponse directement à ce mail.</p>

<p>Au plaisir d'échanger sur votre projet !</p>

<p>Bien à vous,</p>

<p style="margin-top: 24px; font-size: 13px; line-height: 1.5;">
<strong>Norman DADON</strong><br>
Directeur des ventes<br>
<strong>Catella Residential</strong><br>
4 rue de Lasteyrie<br>
75116 Paris<br>
<span style="color:#888;">-----------------------------------------------------------------</span><br>
Tel: +33 (0)1 56 79 79 79<br>
Mobile: +33 (0)6 64 58 24 11<br>
E-mail: <a href="mailto:Norman.Dadon@catella.fr">Norman.Dadon@catella.fr</a><br>
Web: <a href="https://www.catellaresidential.fr">www.catellaresidential.fr</a> | <a href="https://www.catella.com">www.catella.com</a><br>
<span style="color:#888;">-----------------------------------------------------------------</span><br>
<span style="color:#888; font-size: 11px;">P&nbsp;&nbsp; Please consider the environment before printing this e-mail</span>
</p>
</div>`;
}

const ctx = {
  salutation: 'M. Roncin',
  programme: 'Le Haut Bois',
  ville: 'Bagneux',
  promoteur: 'REI',
  accroche_programme: 'situé dans un environnement dynamique et en plein cœur de la ville',
  lien_rdv: 'https://outlook.office.com/bookwithme/user/923d6c795e8a44b8b1703578fea6c819@catella.com/meetingtype/61-yOXWp3EmR-JEFDg44vA2?anonymous',
};

const subject = buildEmailSubject(ctx);
const body = buildEmailBody(ctx);

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Aperçu mail — Catella Lead Automation</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f3f4f6; padding: 24px; margin: 0; }
    .mail { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header-meta { background: #f9fafb; padding: 16px 24px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #374151; }
    .header-meta .label { color: #6b7280; display: inline-block; width: 60px; }
    .body { padding: 24px; }
    .note { max-width: 680px; margin: 24px auto 0; font-size: 12px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <div class="mail">
    <div class="header-meta">
      <div><span class="label">De :</span> Norman Dadon &lt;norman.dadon@catella.com&gt;</div>
      <div><span class="label">À :</span> m.roncin@exemple.fr</div>
      <div><span class="label">Objet :</span> <strong>${subject}</strong></div>
    </div>
    <div class="body">${body}</div>
  </div>
  <div class="note">Aperçu généré le ${new Date().toLocaleString('fr-FR')} — données d'exemple, lead fictif.</div>
</body>
</html>`;

fs.writeFileSync(__dirname + '/apercu-mail.html', html);
console.log('OK — Aperçu généré : previews/apercu-mail.html');
console.log('Objet:', subject);
