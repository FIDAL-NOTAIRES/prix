/**
 * PARAMÈTRES — base de réglages mutualisée entre les outils du cabinet
 *
 * Une seule table, partagée par toute la suite : chaque outil y range ses
 * réglages sous son propre nom. PRIX y conserve son barème de travaux et ses
 * paramètres de frais d'acquisition ; les autres outils s'y brancheront de la
 * même façon, sans nouvelle base à créer.
 *
 * Appels :
 *   GET    /api/parametres?outil=prix                → tous les réglages de l'outil
 *   GET    /api/parametres?outil=prix&cle=reglages   → un seul jeu de réglages
 *   PUT    /api/parametres?outil=prix&cle=reglages   → enregistre (corps JSON)
 *   DELETE /api/parametres?outil=prix&cle=reglages   → supprime
 *
 * La chaîne de connexion est lue dans les variables d'environnement du projet
 * (DATABASE_URL, POSTGRES_URL ou NEON_DATABASE_URL, dans cet ordre).
 */

import { neon } from '@neondatabase/serverless';

const CHAINE = process.env.DATABASE_URL
            || process.env.POSTGRES_URL
            || process.env.NEON_DATABASE_URL
            || '';

const sql = CHAINE ? neon(CHAINE) : null;
let tablePrete = false;

async function assurerTable() {
  if (tablePrete) return;
  await sql`
    create table if not exists parametres (
      outil  text        not null,
      cle    text        not null,
      valeur jsonb       not null,
      maj    timestamptz not null default now(),
      primary key (outil, cle)
    )`;
  tablePrete = true;
}

/* Le corps est déjà analysé par la plateforme quand l'en-tête l'annonce en JSON ;
   on lit le flux à la main dans le cas contraire. */
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

const NOM_VALIDE = /^[a-z0-9_-]{1,40}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!sql) {
    return res.status(503).json({
      erreur: "aucune base de réglages n'est rattachée au projet : renseigner la variable DATABASE_URL"
    });
  }

  const q = req.query || {};
  const outil = String(q.outil || '').toLowerCase();
  const cle = q.cle === undefined ? null : String(q.cle);

  if (!NOM_VALIDE.test(outil)) return res.status(400).json({ erreur: "nom d'outil invalide" });
  if (cle !== null && !NOM_VALIDE.test(cle)) return res.status(400).json({ erreur: 'clé invalide' });

  try {
    await assurerTable();

    if (req.method === 'GET') {
      if (cle === null) {
        const lignes = await sql`
          select cle, valeur, maj from parametres where outil = ${outil} order by cle`;
        return res.status(200).json({ outil, reglages: lignes });
      }
      const lignes = await sql`
        select valeur, maj from parametres where outil = ${outil} and cle = ${cle} limit 1`;
      if (!lignes.length) return res.status(200).json({ outil, cle, valeur: null });
      return res.status(200).json({ outil, cle, valeur: lignes[0].valeur, maj: lignes[0].maj });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      if (cle === null) return res.status(400).json({ erreur: 'clé manquante' });
      const v = await corps(req);
      if (v === null || typeof v !== 'object') {
        return res.status(400).json({ erreur: 'corps attendu : un objet JSON' });
      }
      const texte = JSON.stringify(v);
      if (texte.length > 400000) return res.status(413).json({ erreur: 'réglages trop volumineux' });
      const lignes = await sql`
        insert into parametres (outil, cle, valeur, maj)
        values (${outil}, ${cle}, ${texte}::jsonb, now())
        on conflict (outil, cle)
        do update set valeur = excluded.valeur, maj = now()
        returning maj`;
      return res.status(200).json({ outil, cle, enregistre: true, maj: lignes[0].maj });
    }

    if (req.method === 'DELETE') {
      if (cle === null) return res.status(400).json({ erreur: 'clé manquante' });
      await sql`delete from parametres where outil = ${outil} and cle = ${cle}`;
      return res.status(200).json({ outil, cle, supprime: true });
    }

    return res.status(405).json({ erreur: 'méthode non autorisée' });
  } catch (e) {
    return res.status(502).json({ erreur: String(e && e.message ? e.message : e) });
  }
}
