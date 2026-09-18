/**
 * PRIX — lecture d'une capture d'annonce
 *
 * La page envoie l'image de l'annonce (déposée ou collée) et reçoit en retour
 * les champs exploitables. La lecture se fait ici, côté serveur : les captures
 * d'annonces mêlent polices variables, prix en très gros caractères et
 * pictogrammes, que la reconnaissance embarquée dans le navigateur lit mal.
 *
 * Appel : POST /api/annonce   { image: "<base64 sans en-tête>", format: "image/png" }
 *
 * Nécessite la variable d'environnement ANTHROPIC_API_KEY sur le projet.
 * En son absence la fonction répond proprement et la saisie reste manuelle.
 */

const FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MODELE = 'claude-sonnet-5';

const CONSIGNE = [
  "Tu lis la capture d'écran d'une annonce immobilière française.",
  "Relève uniquement ce qui est écrit noir sur blanc dans l'image. N'invente rien, ne déduis rien.",
  "Réponds par un objet JSON et rien d'autre : pas de texte avant, pas de texte après, pas de balises de code.",
  "Champs attendus, tous facultatifs — mets null quand l'information n'apparaît pas :",
  '  "prix"      : nombre entier, le prix de vente affiché, en euros, sans espace ni symbole',
  '  "surface"   : nombre, la surface habitable en mètres carrés',
  '  "pieces"    : nombre entier de pièces principales',
  '  "chambres"  : nombre entier de chambres',
  '  "type"      : "maison" ou "appartement"',
  '  "ville"     : nom de la commune',
  '  "codePostal": code postal à cinq chiffres',
  '  "adresse"   : rue ou quartier si l\'annonce le précise, sinon null',
  '  "dpe"       : lettre de A à G de l\'étiquette énergie',
  '  "ges"       : lettre de A à G de l\'étiquette climat',
  '  "etage"     : numéro d\'étage pour un appartement',
  '  "terrain"   : surface du terrain en mètres carrés',
  '  "charges"   : montant mensuel des charges de copropriété en euros',
  '  "enLigne"   : ancienneté de la mise en ligne telle qu\'affichée, en toutes lettres',
  '  "honoraires": "acquereur", "vendeur" ou null selon la charge des honoraires d\'agence',
  '  "agence"    : nom de l\'agence ou du réseau',
  "Si l'image n'est pas une annonce immobilière, réponds {\"annonce\": false}."
].join('\n');

async function corps(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  const brut = Buffer.concat(morceaux).toString('utf8');
  if (!brut) return null;
  try { return JSON.parse(brut); } catch (_) { return null; }
}

function extraireJson(texte) {
  let t = String(texte || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const d = t.indexOf('{'), f = t.lastIndexOf('}');
  if (d < 0 || f < d) return null;
  try { return JSON.parse(t.slice(d, f + 1)); } catch (_) { return null; }
}

/* On ne laisse passer que des valeurs de la forme attendue : la page se fie à
   ces champs pour préremplir des calculs. */
function assainir(o) {
  const nb = v => { const n = parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.')); return isFinite(n) && n > 0 ? n : null; };
  const ent = v => { const n = nb(v); return n === null ? null : Math.round(n); };
  const txt = v => { const s = String(v == null ? '' : v).trim(); return s && s.length < 120 ? s : null; };
  const lettre = v => { const s = String(v == null ? '' : v).trim().toUpperCase(); return /^[A-G]$/.test(s) ? s : null; };
  const t = String(o.type == null ? '' : o.type).toLowerCase();
  return {
    prix:       ent(o.prix),
    surface:    nb(o.surface),
    pieces:     ent(o.pieces),
    chambres:   ent(o.chambres),
    type:       t.includes('maison') ? 'maison' : (t.includes('appart') ? 'appartement' : null),
    ville:      txt(o.ville),
    codePostal: /^\d{5}$/.test(String(o.codePostal || '').trim()) ? String(o.codePostal).trim() : null,
    adresse:    txt(o.adresse),
    dpe:        lettre(o.dpe),
    ges:        lettre(o.ges),
    etage:      o.etage === 0 ? 0 : ent(o.etage),
    terrain:    nb(o.terrain),
    charges:    nb(o.charges),
    enLigne:    txt(o.enLigne),
    honoraires: ['acquereur', 'vendeur'].includes(String(o.honoraires || '').toLowerCase()) ? String(o.honoraires).toLowerCase() : null,
    agence:     txt(o.agence)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'méthode non autorisée' });

  const cle = process.env.ANTHROPIC_API_KEY || '';
  if (!cle) {
    return res.status(503).json({
      erreur: "la lecture d'annonce n'est pas activée sur ce projet : renseigner la variable ANTHROPIC_API_KEY"
    });
  }

  const b = await corps(req);
  if (!b || !b.image) return res.status(400).json({ erreur: 'aucune image reçue' });

  const format = FORMATS.includes(b.format) ? b.format : 'image/png';
  const image = String(b.image).replace(/^data:[^,]+,/, '');
  if (image.length > 5200000) {
    return res.status(413).json({ erreur: "capture trop lourde : la réduire ou n'en garder que la partie utile" });
  }

  try {
    const rep = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cle,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELE,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: format, data: image } },
            { type: 'text', text: CONSIGNE }
          ]
        }]
      })
    });

    if (!rep.ok) {
      const t = await rep.text();
      return res.status(502).json({ erreur: "lecture refusée (" + rep.status + ") : " + t.slice(0, 300) });
    }

    const d = await rep.json();
    const texte = (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    const brut = extraireJson(texte);
    if (!brut) return res.status(200).json({ erreur: "la capture n'a pas pu être interprétée", texte: texte.slice(0, 300) });
    if (brut.annonce === false) return res.status(200).json({ erreur: "cette image ne ressemble pas à une annonce immobilière" });

    return res.status(200).json({ champs: assainir(brut) });
  } catch (e) {
    return res.status(502).json({ erreur: String(e && e.message ? e.message : e) });
  }
}
