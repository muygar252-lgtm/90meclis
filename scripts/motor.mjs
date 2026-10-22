// 90MECLİS — otomatik futbol tahmin motoru
import fs from 'node:fs';

const KEY = process.env.FOOTBALL_DATA_KEY;
const SEASON = new Date().getUTCFullYear();
const OUT = 'api';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

if (!KEY) { console.error('HATA: FOOTBALL_DATA_KEY tanımlı değil'); process.exit(1); }

/* ================= MODEL (Dixon-Coles Poisson) ================= */
const MAXG = 8, HALF_LIFE = 300, SHRINK = 6, RHO = -0.05;
const fact = n => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);
const shrink = n => n / (n + SHRINK);

function tau(x, y, lh, la) {
  if (x === 0 && y === 0) return 1 - lh * la * RHO;
  if (x === 0 && y === 1) return 1 + lh * RHO;
  if (x === 1 && y === 0) return 1 + la * RHO;
  if (x === 1 && y === 1) return 1 - RHO;
  return 1;
}

function fitLeague(matches) {
  const now = Date.now();
  const T = new Map();
  let gh = 0, ga = 0, wh = 0, wa = 0;

  for (const m of matches) {
    if (m.hg == null || m.ag == null) continue;
    const days = Math.max(0, (now - Date.parse(m.date)) / 86400000);
    const w = Math.pow(0.5, days / HALF_LIFE);
    if (!T.has(m.home)) T.set(m.home, { sh: 0, ch: 0, mh: 0, sa: 0, ca: 0, ma: 0 });
    if (!T.has(m.away)) T.set(m.away, { sh: 0, ch: 0, mh: 0, sa: 0, ca: 0, ma: 0 });
    const H = T.get(m.home), A = T.get(m.away);
    H.sh += w * m.hg; H.ch += w * m.ag; H.mh += w;
    A.sa += w * m.ag; A.ca += w * m.hg; A.ma += w;
    gh += w * m.hg; ga += w * m.ag; wh += w; wa += w;
  }
  if (wh < 20 || wa < 20) return null;

  const lgH = gh / wh, lgA = ga / wa;
  const strength = {};
  for (const [t, s] of T) {
    const aH = s.mh ? (s.sh / s.mh) / lgH : 1;
    const dH = s.mh ? (s.ch / s.mh) / lgH : 1;
    const aA = s.ma ? (s.sa / s.ma) / lgA : 1;
    const dA = s.ma ? (s.ca / s.ma) / lgA : 1;
    const kH = shrink(s.mh), kA = shrink(s.ma);
    strength[t] = {
      attH: 1 + (aH - 1) * kH, defH: 1 + (dH - 1) * kH,
      attA: 1 + (aA - 1) * kA, defA: 1 + (dA - 1) * kA
    };
  }
  return { lgH, lgA, strength };
}

function predict(model, home, away) {
  const D = { attH: 1, defH: 1, attA: 1, defA: 1 };
  const h = model.strength[home] || D;
  const a = model.strength[away] || D;
  const lh = Math.max(0.15, model.lgH * h.attH * a.defA);
  const la = Math.max(0.15, model.lgA * a.attA * h.defH);

  let tot = 0, hw = 0, dr = 0, aw = 0, o25 = 0, o15 = 0, o35 = 0, kg = 0;
  for (let x = 0; x <= MAXG; x++) {
    for (let y = 0; y <= MAXG; y++) {
      const q = pois(x, lh) * pois(y, la) * tau(x, y, lh, la);
      tot += q;
      if (x > y) hw += q; else if (x === y) dr += q; else aw += q;
      if (x + y > 2.5) o25 += q;
      if (x + y > 1.5) o15 += q;
      if (x + y > 3.5) o35 += q;
      if (x > 0 && y > 0) kg += q;
    }
  }
  const n = v => v / tot;
  const liy = 0.45 * (lh + la);
  const p0 = Math.exp(-liy), p1 = liy * Math.exp(-liy);

  return {
    probs: {
      MS1: n(hw), MSX: n(dr), MS2: n(aw),
      '1X': n(hw + dr), X2: n(aw + dr), '12': n(hw + aw),
      U25: 1 - n(o25), O25: n(o25), U35: 1 - n(o35), O15: n(o15),
      KG: n(kg), KGY: 1 - n(kg),
      IY05: 1 - p0, IY15A: p0 + p1
    },
    xgH: +lh.toFixed(2), xgA: +la.toFixed(2)
  };
}

const LABELS = {
  MS1: 'MS 1', MSX: 'MS X', MS2: 'MS 2',
  '1X': 'Çifte şans 1X', X2: 'Çifte şans X2', '12': 'Çifte şans 12',
  U25: '2.5 Alt', O25: '2.5 Üst', U35: '3.5 Alt', O15: '1.5 Üst',
  KG: 'KG Var', KGY: 'KG Yok', IY05: 'İY 0.5 Üst', IY15A: 'İY 1.5 Alt'
};
const GROUP = {
  MS1: 'ms', MSX: 'ms', MS2: 'ms',
  '1X': 'dc', X2: 'dc', '12': 'dc',
  U25: 'ou', O25: 'ou', U35: 'ou', O15: 'ou',
  KG: 'kg', KGY: 'kg', IY05: 'iy', IY15A: 'iy'
};

/* ================= VERİ KAYNAKLARI ================= */
const FD = 'https://api.football-data.org/v4';
const SDB = 'https://www.thesportsdb.com/api/v1/json/3';

const COMPS = {
  PL: 'Premier Lig', PD: 'La Liga', SA: 'Serie A', BL1: 'Bundesliga',
  FL1: 'Ligue 1', DED: 'Eredivisie', PPL: 'Primeira Liga',
  ELC: 'Championship', CL: 'Şampiyonlar Ligi', BSA: 'Brezilya Serie A'
};

async function fd(path) {
  const r = await fetch(FD + path, { headers: { 'X-Auth-Token': KEY } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchCompetition(code) {
  const now = new Date();
  const past = new Date(now.getTime() - 400 * 86400000);
  const fut = new Date(now.getTime() + 8 * 86400000);
  const f = d => d.toISOString().slice(0, 10);

  const played = await fd(`/competitions/${code}/matches?dateFrom=${f(past)}&dateTo=${f(now)}`);
  await sleep(6500);
  const next = await fd(`/competitions/${code}/matches?dateFrom=${f(now)}&dateTo=${f(fut)}`);
  await sleep(6500);

  const results = (played.matches || [])
    .filter(m => m.status === 'FINISHED' && m.score?.fullTime?.home != null)
    .map(m => ({
      id: String(m.id), league: COMPS[code], date: m.utcDate,
      home: m.homeTeam.name, away: m.awayTeam.name,
      hg: m.score.fullTime.home, ag: m.score.fullTime.away
    }));

  const fixtures = (next.matches || [])
    .filter(m => ['SCHEDULED', 'TIMED', 'IN_PLAY'].includes(m.status))
    .map(m => ({
      id: String(m.id), league: COMPS[code], date: m.utcDate,
      home: m.homeTeam.name, away: m.awayTeam.name,
      crestH: m.homeTeam.crest || null, crestA: m.awayTeam.crest || null
    }));

  return { results, fixtures };
}

async function fetchTurkish(leagueId, name) {
  const out = { results: [], fixtures: [] };
  const seen = new Set();
  for (const s of [`${SEASON}-${SEASON + 1}`, `${SEASON - 1}-${SEASON}`]) {
    try {
      const r = await fetch(`${SDB}/eventsseason.php?id=${leagueId}&s=${s}`);
      const j = await r.json();
      for (const e of j.events || []) {
        if (seen.has(e.idEvent)) continue;
        seen.add(e.idEvent);
        const hg = e.intHomeScore === null || e.intHomeScore === '' ? null : +e.intHomeScore;
        const ag = e.intAwayScore === null || e.intAwayScore === '' ? null : +e.intAwayScore;
        const row = {
          id: e.idEvent, league: name,
          date: new Date(`${e.dateEvent}T${e.strTime || '18:00:00'}Z`).toISOString(),
          home: e.strHomeTeam, away: e.strAwayTeam, hg, ag,
          crestH: e.strHomeTeamBadge || null, crestA: e.strAwayTeamBadge || null
        };
        if (hg != null && ag != null) out.results.push(row);
        else out.fixtures.push(row);
      }
    } catch (e) { console.warn(`  ! ${name} ${s}: ${e.message}`); }
    await sleep(1500);
  }
  return out;
}

/* ================= ANA AKIŞ ================= */
const byLeague = new Map();
const fixtures = [];

console.log('--- Veri çekiliyor ---');
for (const code of Object.keys(COMPS)) {
  try {
    const { results, fixtures: fx } = await fetchCompetition(code);
    byLeague.set(COMPS[code], results);
    fixtures.push(...fx);
    console.log(`  ok ${COMPS[code]}: ${results.length} sonuç, ${fx.length} maç`);
  } catch (e) { console.log(`  hata ${COMPS[code]}: ${e.message}`); }
}

for (const [id, name] of [[4339, 'Süper Lig'], [4340, '1. Lig']]) {
  try {
    const { results, fixtures: fx } = await fetchTurkish(id, name);
    byLeague.set(name, results);
    fixtures.push(...fx);
    console.log(`  ok ${name}: ${results.length} sonuç, ${fx.length} maç`);
  } catch (e) { console.log(`  hata ${name}: ${e.message}`); }
}

console.log('--- Tahmin üretiliyor ---');
const horizon = Date.now() + 3 * 86400000;
const matches = [];
const models = new Map();

for (const [lg, hist] of byLeague) {
  const m = fitLeague(hist);
  if (m) models.set(lg, m);
}

for (const f of fixtures) {
  if (Date.parse(f.date) > horizon) continue;
  const model = models.get(f.league);
  if (!model) continue;

  const p = predict(model, f.home, f.away);
  const picks = {};
  for (const [code, prob] of Object.entries(p.probs)) {
    const g = GROUP[code];
    if (!picks[g] || prob > picks[g].prob) picks[g] = { code, prob };
  }
  const ranked = Object.values(picks).sort((a, b) => b.prob - a.prob);
  if (!ranked.length) continue;

  matches.push({
    id: f.id, league: f.league, date: f.date,
    home: f.home, away: f.away,
    crestH: f.crestH, crestA: f.crestA,
    xgH: p.xgH, xgA: p.xgA,
    picks: ranked.slice(0, 4).map(x => ({
      code: x.code, label: LABELS[x.code], prob: +(x.prob * 100).toFixed(1)
    }))
  });
}
matches.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
console.log(`  ${matches.length} maç`);

/* --- günün kuponu --- */
const cands = [];
for (const m of matches) for (const p of m.picks) if (p.prob >= 68 && p.prob <= 92) cands.push({ ...p, match: m });
cands.sort((a, b) => b.prob - a.prob);

const kupon = [], usedLg = new Set(), usedM = new Set();
for (const c of cands) {
  if (usedLg.has(c.match.league) || usedM.has(c.match.id)) continue;
  usedLg.add(c.match.league); usedM.add(c.match.id);
  kupon.push(c);
  if (kupon.length === 3) break;
}

/* --- karne --- */
const allResults = new Map();
for (const rows of byLeague.values()) for (const r of rows) allResults.set(r.id, r);

function won(code, h, a) {
  const t = h + a;
  switch (code) {
    case 'MS1': return h > a;   case 'MSX': return h === a;  case 'MS2': return a > h;
    case '1X':  return h >= a;  case 'X2':  return a >= h;   case '12':  return h !== a;
    case 'O25': return t > 2.5; case 'U25': return t < 2.5;
    case 'O15': return t > 1.5; case 'U35': return t < 3.5;
    case 'KG':  return h > 0 && a > 0; case 'KGY': return h === 0 || a === 0;
    default: return false;
  }
}

const kPath = `${OUT}/karne.json`;
let karne = fs.existsSync(kPath) ? JSON.parse(fs.readFileSync(kPath, 'utf8')) : [];
for (const k of karne) {
  if (k.status !== 'pending') continue;
  const r = allResults.get(k.matchId);
  if (!r) continue;
  k.status = won(k.code, r.hg, r.ag) ? 'won' : 'lost';
  k.score = `${r.hg}-${r.ag}`;
}

const today = new Date().toISOString().slice(0, 10);
for (const k of kupon) {
  if (karne.some(x => x.matchId === k.match.id && x.code === k.code && x.date === today)) continue;
  karne.push({
    date: today, matchId: k.match.id, code: k.code, label: k.label,
    prob: k.prob, match: `${k.match.home} - ${k.match.away}`,
    league: k.match.league, status: 'pending', score: null
  });
}

const settled = karne.filter(k => k.status !== 'pending');
const wonCount = settled.filter(k => k.status === 'won').length;
const meta = {
  updated: new Date().toISOString(),
  matches: matches.length,
  leagues: byLeague.size,
  settled: settled.length,
  won: wonCount,
  rate: settled.length ? +(wonCount / settled.length * 100).toFixed(1) : 0
};

fs.writeFileSync(`${OUT}/tahminler.json`, JSON.stringify({ meta, matches }));
fs.writeFileSync(`${OUT}/kupon.json`, JSON.stringify({
  date: today, meta,
  picks: kupon.map(k => ({
    matchId: k.match.id, match: `${k.match.home} - ${k.match.away}`,
    league: k.match.league, time: k.match.date,
    code: k.code, label: k.label, prob: k.prob
  }))
}));
fs.writeFileSync(kPath, JSON.stringify(karne.slice(-3000)));
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
console.log(`--- BİTTİ: ${matches.length} maç, ${kupon.length} kupon, karne %${meta.rate} (${settled.length} sonuçlanmış) ---`);

/* ================= TELEGRAM ================= */
const TG = process.env.TELEGRAM_TOKEN, CH = process.env.TELEGRAM_CHAT;
if (TG && CH && kupon.length) {
  const lines = [
    '<b>90MECLİS · GÜNÜN KUPONU</b>',
    `<i>${today}</i>`, '',
    ...kupon.map((k, i) => `<b>${i + 1}.</b> ${k.match.h || ''}${k.match.home || ''} - ${k.match.away || ''}\n     ${k.label} · güven %${k.prob}\n     <i>${k.match.league}</i>`),
    '',
    `Karne: %${meta.rate} (${settled.length} sinyal)`
  ];
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CH, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true })
    });
    console.log('telegram:', (await r.json()).ok ? 'gönderildi' : 'hata');
  } catch (e) { console.log('telegram hata:', e.message); }
}
