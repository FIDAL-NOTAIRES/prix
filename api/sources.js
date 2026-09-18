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
 *   /api/sources?type=loyer&insee=59368&bien=maison
 */

function distM(la1, lo1, la2, lo2) {
  if (!isFinite(la1) || !isFinite(lo1)) return 1e9;
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function decoupeSep(l, sep) {
  const r = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === sep && !q) { r.push(cur); cur = ''; continue; }
    cur += ch;
  }
  r.push(cur);
  return r;
}
function decoupe(l) { return decoupeSep(l, ','); }

async function ventes(insee, annee, lat, lon, rayon) {
  const dep = insee.startsWith('97') ? insee.slice(0, 3) : insee.slice(0, 2);
  const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/${annee}/communes/${dep}/${insee}.csv`;
  const rep = await fetch(url, { headers: { 'user-agent': 'PRIX-FIDAL-Notaires' } });
  if (!rep.ok) return { annee, absent: true, statut: rep.status, ventes: [] };

  const txt = await rep.text();
  const lignes = txt.split('\n');
  const ent = lignes[0].split(',');
  const i = (n) => ent.indexOf(n);
  const iId = i('id_mutation'), iVf = i('valeur_fonciere'), iSb = i('surface_reelle_bati'),
        iTl = i('type_local'), iVo = i('adresse_nom_voie'), iLa = i('latitude'), iLo = i('longitude'),
        iDt = i('date_mutation'), iNa = i('nature_mutation'), iSt = i('surface_terrain'),
        iPi = i('nombre_pieces_principales');
  if (iId < 0 || iVf < 0 || iSb < 0 || iTl < 0) return { annee, erreur: 'colonnes inattendues', ventes: [] };

  /* Regroupement par mutation : le fichier compte une ligne par lot ou par parcelle,
     et chaque ligne reporte le prix TOTAL de la vente. Diviser ce prix par la surface
     d'une seule ligne surestimerait le prix au m². */
  const mut = new Map();
  for (let k = 1; k < lignes.length; k++) {
    const l = lignes[k];
    if (!l) continue;
    const c = l.indexOf('"') < 0 ? l.split(',') : decoupe(l);
    const id = c[iId];
    if (!id) continue;
    const vf = +c[iVf];
    if (!vf || vf < 10000) continue;
    if (iNa >= 0 && c[iNa] && c[iNa] !== 'Vente') continue;   /* on écarte échanges, VEFA, adjudications */

    let m = mut.get(id);
    if (!m) { m = { vf, locaux: [], terrain: 0, voie: '', lat: NaN, lon: NaN, an: iDt >= 0 ? c[iDt] : String(annee) }; mut.set(id, m); }
    const tl = c[iTl] || '';
    const sb = +c[iSb] || 0;
    if (tl && sb > 0) {
      m.locaux.push({ tl, sb, pi: iPi >= 0 ? +c[iPi] || 0 : 0 });
      if (iVo >= 0 && !m.voie) m.voie = c[iVo] || '';
      if (iLa >= 0 && !isFinite(m.lat)) { m.lat = +c[iLa]; m.lon = +c[iLo]; }
    } else if (iSt >= 0) {
      m.terrain += +c[iSt] || 0;
    }
  }

  const out = [];
  let multi = 0;
  for (const m of mut.values()) {
    if (m.locaux.length === 0) continue;                       /* terrain nu */
    const bati = m.locaux.filter(x => x.tl === 'Maison' || x.tl === 'Appartement');
    if (bati.length !== 1) { multi++; continue; }               /* vente multi-lots : non interprétable */
    const p = bati[0];
    if (p.sb < 9) continue;
    if (distM(m.lat, m.lon, +lat, +lon) > +rayon) continue;
    out.push({ vf: m.vf, sb: p.sb, tl: p.tl, pi: p.pi, voie: m.voie, st: m.terrain, lat: m.lat, lon: m.lon, an: m.an });
  }
  return { annee, ventes: out, mutations: mut.size, ecartees: multi };
}

/* Commerces, équipements et transports.
   Source principale : la BD TOPO de l'IGN, sur la même infrastructure publique que
   le cadastre, qui répond de façon fiable. Secours : les serveurs communautaires
   OpenStreetMap, gratuits mais fréquemment saturés. */
async function viaIgn(lat, lon, rayon) {
  const dLa = rayon / 111000, dLo = rayon / (111000 * Math.cos(lat * Math.PI / 180));
  const bbox = [lat - dLa, lon - dLo, lat + dLa, lon + dLo].join(',') + ',EPSG:4326';
  const couches = ['BDTOPO_V3:zone_d_activite_ou_d_interet', 'BDTOPO_V3:equipement_de_transport'];
  let total = 0, lues = 0, detail = {};
  for (const c of couches) {
    const u = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
      + '&outputFormat=application/json&count=1&SRSNAME=EPSG:4326&TYPENAMES=' + encodeURIComponent(c)
      + '&BBOX=' + encodeURIComponent(bbox);
    try {
      const rep = await fetch(u, { headers: { 'user-agent': 'PRIX-FIDAL-Notaires' } });
      if (!rep.ok) continue;
      const d = await rep.json();
      const n = d.numberMatched !== undefined ? +d.numberMatched
              : (d.totalFeatures !== undefined ? +d.totalFeatures : (d.features || []).length);
      if (!isFinite(n)) continue;
      total += n; lues++; detail[c.split(':')[1]] = n;
    } catch (e) { /* on passe à la couche suivante */ }
  }
  if (!lues) throw new Error('BD TOPO sans réponse exploitable');
  return { n: total, source: 'BD TOPO (IGN)', detail };
}

async function viaOsm(lat, lon, rayon) {
  const c = `${lat},${lon}`;
  const req = '[out:json][timeout:20];('
    + `nwr(around:${rayon},${c})[shop];`
    + `nwr(around:${rayon},${c})[amenity~"^(school|pharmacy|supermarket|bakery)$"];`
    + `nwr(around:${rayon},${c})[public_transport=station];`
    + `nwr(around:${rayon},${c})[highway=bus_stop];`
    + ');out count;';                     /* on ne demande que le compte, pas la liste */
  const miroirs = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const echecs = [];
  for (const m of miroirs) {
    for (let essai = 1; essai <= 2; essai++) {
      try {
        const rep = await fetch(m + '?data=' + encodeURIComponent(req), {
          headers: { 'user-agent': 'PRIX-FIDAL-Notaires' }
        });
        if (!rep.ok) { echecs.push(`${new URL(m).hostname} : HTTP ${rep.status}`); break; }
        const d = await rep.json();
        const t = (d.elements || [])[0];
        const n = t && t.tags ? (+t.tags.total || +t.tags.nodes + +t.tags.ways + +t.tags.relations || 0)
                              : (d.elements || []).length;
        return { n: n, source: new URL(m).hostname };
      } catch (e) {
        echecs.push(`${new URL(m).hostname} : ${e.message}`);
        if (essai === 1) await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  throw new Error(echecs.join(' — '));
}

async function pointsInteret(lat, lon, rayon) {
  try { return await viaIgn(lat, lon, rayon); }
  catch (e1) {
    try { return await viaOsm(lat, lon, rayon); }
    catch (e2) { throw new Error('IGN : ' + e1.message + ' — OSM : ' + e2.message); }
  }
}

/* ---------- Loyers d'annonce : carte des loyers (ANIL / DGALN) ----------
   Fichier national par commune, un jeu par millésime et un fichier par type de
   bien. Les adresses de téléchargement changent d'un millésime à l'autre : on
   les demande au catalogue plutôt que de les inscrire en dur, et on retombe sur
   le millésime précédent si le plus récent n'est pas exploitable.
   Les loyers publiés sont des loyers d'ANNONCE, exprimés CHARGES COMPRISES ;
   l'abattement de retour au hors-charges est appliqué côté page. */

const MILLESIMES = ['2025', '2024', '2023'];
const cacheLoyers = new Map();   /* type de bien -> { millesime, idx } ; survit aux appels à chaud */

async function ressourcesLoyers(annee) {
  const u = 'https://www.data.gouv.fr/api/1/datasets/'
          + 'carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-' + annee + '/';
  const rep = await fetch(u, { headers: { 'user-agent': 'PRIX-FIDAL-Notaires' } });
  if (!rep.ok) throw new Error('catalogue ' + annee + ' : HTTP ' + rep.status);
  const d = await rep.json();
  return (d.resources || []).filter(r => /csv/i.test(r.format || '') || /\.csv/i.test(r.url || ''));
}

function choisirRessource(res, bien) {
  const t = r => ((r.title || '') + ' ' + (r.url || '')).toLowerCase();
  if (bien === 'maison') return res.find(r => /maison/.test(t(r))) || null;
  /* appartement : on veut le fichier toutes typologies, non les déclinaisons par nombre de pièces */
  const ap = res.filter(r => /appart/.test(t(r)));
  return ap.find(r => !/(1\s*-?\s*2|3\s*pi|pieces|pièces|typologie)/.test(t(r))) || ap[0] || null;
}

/* Les intitulés de colonnes ont varié d'un millésime à l'autre : on les repère
   par motif plutôt que par position. */
function analyseCsv(txt) {
  const lignes = txt.split(/\r?\n/);
  if (lignes.length < 2) throw new Error('fichier de loyers vide');
  const sep = (lignes[0].match(/;/g) || []).length > (lignes[0].match(/,/g) || []).length ? ';' : ',';
  const ent = lignes[0].split(sep).map(x => x.replace(/^"|"$/g, '').trim());
  const ou = re => ent.findIndex(x => re.test(x));
  const iIns = ou(/insee/i);
  let   iLoy = ou(/loypred/i);
  if (iLoy < 0) iLoy = ou(/loy.*m2|loyer/i);
  const iLib = ou(/libgeo|nom_?com|commune/i);
  const iBas = ou(/lwr|_inf|borne_?inf/i);
  const iHau = ou(/upr|_sup|borne_?sup/i);
  const iTyp = ou(/typpred|type_?pred/i);
  const iNb  = ou(/nbobs/i);
  if (iIns < 0 || iLoy < 0) throw new Error('colonnes inattendues : ' + ent.slice(0, 12).join(' | '));

  const nb = v => { const n = parseFloat(String(v == null ? '' : v).replace(/"/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
  const tx = v => String(v == null ? '' : v).replace(/"/g, '').trim();
  const idx = new Map();
  for (let k = 1; k < lignes.length; k++) {
    const l = lignes[k];
    if (!l) continue;
    const c = l.indexOf('"') < 0 ? l.split(sep) : decoupeSep(l, sep);
    const ins = tx(c[iIns]).toUpperCase();
    if (ins.length < 4) continue;
    const loy = nb(c[iLoy]);
    if (loy === null || loy <= 0) continue;
    idx.set(ins.padStart(5, '0'), {
      loyer: loy,
      commune: iLib >= 0 ? tx(c[iLib]) : '',
      bas: iBas >= 0 ? nb(c[iBas]) : null,
      haut: iHau >= 0 ? nb(c[iHau]) : null,
      typpred: iTyp >= 0 ? tx(c[iTyp]) : '',
      nbobs: iNb >= 0 ? nb(c[iNb]) : null
    });
  }
  if (!idx.size) throw new Error('aucune commune lue dans le fichier de loyers');
  return idx;
}

async function loyers(insee, bien) {
  const enCache = cacheLoyers.get(bien);
  if (enCache) return { millesime: enCache.millesime, ligne: enCache.idx.get(insee) || null };

  let dernier = null;
  for (const annee of MILLESIMES) {
    try {
      const r = choisirRessource(await ressourcesLoyers(annee), bien);
      if (!r) { dernier = new Error('aucun fichier ' + bien + ' en ' + annee); continue; }
      const rep = await fetch(r.url, { headers: { 'user-agent': 'PRIX-FIDAL-Notaires' } });
      if (!rep.ok) { dernier = new Error('fichier ' + annee + ' : HTTP ' + rep.status); continue; }
      const idx = analyseCsv(await rep.text());
      cacheLoyers.set(bien, { millesime: annee, idx });
      return { millesime: annee, ligne: idx.get(insee) || null };
    } catch (e) { dernier = e; }
  }
  throw dernier || new Error('carte des loyers indisponible');
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
    if (type === 'loyer') {
      const insee = String(q.insee || '').toUpperCase();
      const bien = q.bien === 'appartement' ? 'appartement' : 'maison';
      if (!/^[0-9AB]{5}$/i.test(insee)) return res.status(400).json({ erreur: 'code commune invalide' });
      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
      const d = await loyers(insee, bien);
      if (!d.ligne) return res.status(200).json({ millesime: d.millesime, bien, loyer: null, erreur: 'commune absente du fichier ' + d.millesime });
      return res.status(200).json({
        millesime: d.millesime, bien, insee,
        commune: d.ligne.commune,
        loyer: d.ligne.loyer,           /* €/m²/mois, CHARGES COMPRISES */
        bas: d.ligne.bas, haut: d.ligne.haut, nbobs: d.ligne.nbobs,
        estime: !!(d.ligne.typpred && !/commune/i.test(d.ligne.typpred)),
        source: "Carte des loyers (ANIL / DGALN) — loyers d'annonce charges comprises"
      });
    }
    if (type === 'poi') {
      res.setHeader('Cache-Control', 's-maxage=2592000, stale-while-revalidate=2592000');
      const d = await pointsInteret(+q.lat, +q.lon, +(q.r || 600));
      return res.status(200).json(d);
    }
    return res.status(400).json({ erreur: 'type inconnu' });
  } catch (e) {
    return res.status(502).json({ erreur: String(e && e.message ? e.message : e) });
  }
}
