// Did the odds actually know? Scored against matches that are already decided.
// Universe: UEFA Europa League qualifying, second round, played 23 July 2026.

const SOURCES = [
  'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa_qual/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.conference_qual/scoreboard',
];

const num = v => (v == null ? null : typeof v === 'string' ? Number(v.replace('+', '')) : Number(v));
const mlToProb = ml => (ml == null || Number.isNaN(ml) ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

function devig(h, d, a) {
  if (h == null || d == null || a == null) return null;
  const s = h + d + a;
  return s ? { home: h / s, draw: d / s, away: a / s } : null;
}

async function getJson(url, ms = 5000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'sixline/0.3' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 's-maxage=120, stale-while-revalidate=600');

  const boards = await Promise.all(SOURCES.map(u => getJson(u)));
  const events = boards.filter(Boolean).flatMap(b => b.events || []);
  const finished = events.filter(e => /FULL_TIME|STATUS_FINAL/.test(e.competitions?.[0]?.status?.type?.name || ''));

  const scored = [];
  for (const ev of finished) {
    const comp = ev.competitions[0];
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    const o = comp.odds?.[0];
    if (!o || !home || !away) continue;

    // pre-match view: the opening line, set before anyone knew anything
    const ml = {
      home: num(o?.moneyline?.home?.open?.odds ?? o?.moneyline?.home?.close?.odds),
      away: num(o?.moneyline?.away?.open?.odds ?? o?.moneyline?.away?.close?.odds),
      draw: num(o?.drawOdds?.open?.odds ?? o?.drawOdds?.moneyLine),
    };
    const p = devig(mlToProb(ml.home), mlToProb(ml.draw), mlToProb(ml.away));
    if (!p) continue;

    const hs = Number(home.score), as = Number(away.score);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    const actual = hs > as ? 'home' : hs < as ? 'away' : 'draw';

    const predicted = ['home', 'draw', 'away'].reduce((b, k) => (p[k] > p[b] ? k : b), 'home');
    // Brier score for the three-outcome case: lower is better, 0.667 is a coin toss
    const brier = ['home', 'draw', 'away'].reduce((a, k) => a + Math.pow(p[k] - (actual === k ? 1 : 0), 2), 0);

    scored.push({
      match: `${home.team.displayName} ${hs}-${as} ${away.team.displayName}`,
      predicted, actual, hit: predicted === actual,
      confidence: Number(p[predicted].toFixed(3)),
      brier: Number(brier.toFixed(3)),
      probs: { home: Number(p.home.toFixed(3)), draw: Number(p.draw.toFixed(3)), away: Number(p.away.toFixed(3)) },
    });
  }

  const n = scored.length;
  const hits = scored.filter(s => s.hit).length;

  return res.status(200).json({
    meta: {
      question: 'on matches already played, did the pre match odds pick the winner?',
      universe: 'uefa europa and conference league qualifying, second round, 23 july 2026',
      matches_scored: n,
      hit_rate: n ? Number((hits / n).toFixed(3)) : null,
      mean_brier: n ? Number((scored.reduce((a, s) => a + s.brier, 0) / n).toFixed(3)) : null,
      baseline_brier_coin_toss: 0.667,
      note: n ? 'scored against real final scores, not a simulation' : 'no finished match carried odds upstream, so nothing is claimed',
      degraded: n < 3,
    },
    results: scored,
  });
}
