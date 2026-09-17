/**
 * PRIX — relais de sources publiques
 *
 * Certains services publics ne délivrent pas l'en-tête d'autorisation d'accès
 * qui permettrait au navigateur de les appeler directement (fichiers Etalab,
 * serveurs de données cartographiques collaboratives). Cette fonction les
 * interroge depuis le serveur, filtre la donnée et la renvoie à la page.
 *
 * Appels :
 *   /api/sources?type=dvf&insee=59368&annee=2024&lat=50.65&lon=3.07&r=700
 *   /api/sources?type=poi&lat=50.65&lon=3.07&r=600
 */

function distM(la1, lo1, la2, lo2) {
  if (!isFinite(la1) || !isFinite(lo1)) return 1e9;
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function decoupe(l) {
  const r = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { r.push(cur); cur = ''; continue; }
    cur += ch;
  }
  r.push(cur);
  return r;
}

async function ventes(insee, annee, lat, lon, rayon) {
  const dep = insee.startsWith('97') ? insee.slice(0, 3) : insee.slice(0, 2);
  const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/${annee}/communes/${dep}/${insee}.csv`;
  const rep = await fetch(url, { headers: { 'user-agent': 'PRIX-FIDAL-Notaires' } });
  if (!rep.ok) return { annee, absent: true, statut: rep.status, ventes: [] };

  const txt = await rep.text();
  const lignes = txt.split('\n');
  const ent = lignes[0].split(',');
  const i = (n) => ent.indexOf(n);
  const iVf = i('valeur_fonciere'), iSb = i('surface_reelle_bati'), iTl = i('type_local'),
        iVo = i('adresse_nom_voie'), iLa = i('latitude'), iLo = i('longitude'), iDt = i('date_mutation'),
        iSt = i('surface_terrain'), iPi = i('nombre_pieces_principales');
  if (iVf < 0 || iSb < 0 || iTl < 0) return { annee, erreur: 'colonnes inattendues', ventes: [] };

  const out = [];
  for (let k = 1; k < lignes.length; k++) {
    const l = lignes[k];
    if (!l) continue;
    const c = l.indexOf('"') < 0 ? l.split(',') : decoupe(l);
    const vf = +c[iVf], sb = +c[iSb];
    if (!vf || !sb || vf < 10000 || sb < 9) continue;
    const la = +c[iLa], lo = +c[iLo];
    if (distM(la, lo, +lat, +lon) > +rayon) continue;
    out.push({
      vf, sb,
      tl: c[iTl] || '',
      voie: (iVo >= 0 ? c[iVo] : '') || '',
      st: iSt >= 0 ? +c[iSt] || 0 : 0,
      pi: iPi >= 0 ? +c[iPi] || 0 : 0,
      lat: la, lon: lo,
      an: iDt >= 0 ? c[iDt] : String(annee)
    });
  }
  return { annee, ventes: out };
}

async function pointsInteret(lat, lon, rayon) {
  const c = `${lat},${lon}`;
  const req = '[out:json][timeout:25];('
    + `nwr(around:${rayon},${c})[shop];`
    + `nwr(around:${rayon},${c})[amenity~"^(school|pharmacy|supermarket|bakery)$"];`
    + `nwr(around:${rayon},${c})[public_transport=station];`
    + `nwr(around:${rayon},${c})[highway=bus_stop];`
    + ');out ids;';
  const miroirs = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const echecs = [];
  for (const m of miroirs) {
    try {
      const rep = await fetch(m + '?data=' + encodeURIComponent(req), {
        headers: { 'user-agent': 'PRIX-FIDAL-Notaires' }
      });
      if (!rep.ok) { echecs.push(`${new URL(m).hostname} : HTTP ${rep.status}`); continue; }
      const d = await rep.json();
      return { n: (d.elements || []).length, source: new URL(m).hostname };
    } catch (e) {
      echecs.push(`${new URL(m).hostname} : ${e.message}`);
    }
  }
  throw new Error(echecs.join(' — '));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');

  const q = req.query || {};
  const type = q.type || 'dvf';

  try {
    if (type === 'dvf') {
      const insee = String(q.insee || '');
      const annee = String(q.annee || '');
      if (!/^[0-9AB]{5}$/i.test(insee)) return res.status(400).json({ erreur: 'code commune invalide' });
      if (!/^20\d\d$/.test(annee)) return res.status(400).json({ erreur: 'année invalide' });
      const d = await ventes(insee, annee, q.lat, q.lon, q.r || 700);
      return res.status(200).json(d);
    }
    if (type === 'poi') {
      const d = await pointsInteret(+q.lat, +q.lon, +(q.r || 600));
      return res.status(200).json(d);
    }
    return res.status(400).json({ erreur: 'type inconnu' });
  } catch (e) {
    return res.status(502).json({ erreur: String(e && e.message ? e.message : e) });
  }
}
