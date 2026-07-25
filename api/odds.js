// sixline — bookmaker consensus over the 6 UCL qualifying matches of 28 July 2026.
// Rule: never invent a number. A source that does not answer is declared absent.

const LEAGUE = 'uefa.champions_qual';
const SCOREBOARD = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard`;
const METHODOLOGY = 'v0.3';

// Declared sources. Anything unreachable stays in the response as absent, with a reason.
const DECLARED_SOURCES = [
  { name: 'DraftKings', via: 'espn', status: 'unknown', reason: '' },
  { name: 'ESPN BET', via: 'espn-core', status: 'unknown', reason: '' },
  { name: 'Bet365', via: 'direct', status: 'absent', reason: 'anti-bot' },
  { name: 'Goldbet', via: 'direct', status: 'absent', reason: 'geo-restricted IT' },
  { name: 'Sisal', via: 'direct', status: 'absent', reason: 'geo-restricted IT' },
];

// american moneyline -> implied probability
function mlToProb(ml) {
  if (ml == null || Number.isNaN(Number(ml))) return null;
  const n = Number(ml);
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

// strip the bookmaker margin so the three outcomes sum to 1
function devig(h, d, a) {
  if (h == null || d == null || a == null) return null;
  const s = h + d + a;
  if (!s) return null;
  return { home: h / s, draw: d / s, away: a / s, overround: s - 1 };
}

const num = v => (v == null ? null : typeof v === 'string' ? Number(v.replace('+', '')) : Number(v));

// ESPN shape: odds[].moneyline.{home,away}.{open,close}.odds (strings like "-130"),
// draw lives apart in odds[].drawOdds.moneyLine (number).
function pickMoneylines(o, phase = 'close') {
  const ml = o?.moneyline;
  const home = num(ml?.home?.[phase]?.odds ?? ml?.home?.close?.odds);
  const away = num(ml?.away?.[phase]?.odds ?? ml?.away?.close?.odds);
  const draw = num(
    phase === 'open'
      ? (o?.drawOdds?.open?.odds ?? o?.drawOdds?.moneyLine)
      : (o?.drawOdds?.close?.odds ?? o?.drawOdds?.moneyLine)
  );
  return { home, draw, away };
}

async function getJson(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'sixline/0.3' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const frozenAt = new Date().toISOString();
  const board = await getJson(SCOREBOARD, 6000);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');

  if (!board?.events?.length) {
    return res.status(503).json({
      meta: { frozen_at: frozenAt, methodologyVersion: METHODOLOGY, coverage: 0, degraded: true,
              sources: DECLARED_SOURCES.map(s => ({ ...s, status: 'absent', reason: s.reason || 'upstream down' })) },
      matches: [],
      note: 'upstream unreachable. showing nothing rather than a guess.',
    });
  }

  const sourcesSeen = new Set();
  let covered = 0;

  const matches = board.events.map(ev => {
    const comp = ev.competitions?.[0];
    const cs = comp?.competitors || [];
    const homeC = cs.find(c => c.homeAway === 'home');
    const awayC = cs.find(c => c.homeAway === 'away');

    const books = [];
    for (const o of comp?.odds || []) {
      const name = o?.provider?.name;
      const ml = pickMoneylines(o);
      const probs = devig(mlToProb(ml.home), mlToProb(ml.draw), mlToProb(ml.away));
      if (!name || !probs) continue;
      sourcesSeen.add(name);
      books.push({ name, home: ml.home, draw: ml.draw, away: ml.away, probs, overround: probs.overround });
    }

    // consensus = mean of de-vigged probabilities across reachable books
    let consensus = null, disagreement = null;
    if (books.length) {
      const avg = k => books.reduce((a, b) => a + b.probs[k], 0) / books.length;
      consensus = { home: avg('home'), draw: avg('draw'), away: avg('away') };
      // disagreement = max spread on any single outcome across books
      disagreement = Math.max(...['home', 'draw', 'away'].map(k => {
        const v = books.map(b => b.probs[k]);
        return Math.max(...v) - Math.min(...v);
      }));
      covered++;
    }

    return {
      id: ev.id,
      home: homeC?.team?.displayName || 'unknown',
      away: awayC?.team?.displayName || 'unknown',
      kickoff_utc: ev.date,
      kickoff_local: new Date(ev.date).toISOString().slice(11, 16) + ' UTC',
      status: comp?.status?.type?.name,
      books,
      consensus,
      disagreement: books.length > 1 ? disagreement : null,
      sources_used: books.length,
      sources_total: DECLARED_SOURCES.length,
      provenance: books.length ? 'live' : 'absent',
      degraded: books.length < 2,
    };
  });

  const sources = DECLARED_SOURCES.map(s =>
    sourcesSeen.has(s.name)
      ? { name: s.name, status: 'live', reason: '' }
      : { name: s.name, status: 'absent', reason: s.reason || 'not offered upstream' }
  );

  return res.status(200).json({
    meta: {
      frozen_at: frozenAt,
      methodologyVersion: METHODOLOGY,
      league: 'UEFA Champions League Qualifying, Second Round',
      match_count: matches.length,
      coverage: matches.length ? covered / matches.length : 0,
      degraded: sourcesSeen.size < 2,
      sources,
      method: 'american moneyline -> implied probability -> multiplicative devig -> mean across reachable books',
    },
    matches,
  });
}
