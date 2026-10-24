// Sequence a playlist for a party using the DJ rules from the research:
// harmonic (Camelot) compatibility + small BPM steps (half/double-time aware) +
// an energy arc (warm-up -> peak ~70% through -> ease down).
// Pure functions — no audio — so they're easy to unit-test.

const CAMELOT_RE = /^(\d{1,2})([AB])$/;

function parseCamelot(c) {
  if (!c) return null;
  const m = CAMELOT_RE.exec(String(c).trim());
  return m ? { num: parseInt(m[1], 10), letter: m[2] } : null;
}

function circDist(a, b) {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

// Harmonic compatibility, 1 = perfect ... 0.2 = clash. Null-tolerant (neutral 0.5).
export function camelotCompat(ca, cb) {
  const a = parseCamelot(ca);
  const b = parseCamelot(cb);
  if (!a || !b) return 0.5;
  if (a.num === b.num && a.letter === b.letter) return 1.0; // same key
  if (a.num === b.num) return 0.9; // relative major/minor (A<->B)
  if (a.letter === b.letter && circDist(a.num, b.num) === 1) return 0.9; // +/-1 (a 5th)
  if (a.letter === b.letter) {
    const up = (b.num - a.num + 12) % 12;
    if (up === 7 || up === 2 || up === 5 || up === 10) return 0.6; // energy-boost moves
  }
  return 0.2; // dissonant
}

// 0 = same tempo. Considers exact half/double-time relationships.
export function bpmDistance(ba, bb) {
  if (!Number.isFinite(ba) || !Number.isFinite(bb) || ba <= 0 || bb <= 0) return 0.3;
  const d = (x, y) => Math.abs(x - y) / ((x + y) / 2);
  return Math.min(d(ba, bb), d(ba, 2 * bb), d(2 * ba, bb));
}

export function transitionQuality(a, b) {
  const key = camelotCompat(a.camelot, b.camelot);
  const bpm = bpmDistance(a.bpm, b.bpm);
  let label = "ok";
  if (key >= 0.9 && bpm <= 0.06) label = "perfect";
  else if (key >= 0.6 && bpm <= 0.08) label = "good";
  else if (key < 0.4 || bpm > 0.12) label = "rough";
  return {
    keyCompat: +key.toFixed(2),
    bpmDeltaPct: Math.round(bpm * 100),
    energyStep: (b.energy ?? 5) - (a.energy ?? 5),
    label,
  };
}

function pairwise(list) {
  const out = [];
  for (let i = 0; i < list.length - 1; i++) out.push(transitionQuality(list[i], list[i + 1]));
  return out;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Rank tracks by absolute energy and spread to 1-10. Energy is a noisy absolute
// heuristic, so for set-ordering we use each track's RANK within the playlist.
export function relativeEnergies(tracks) {
  const n = tracks.length;
  if (n === 0) return [];
  const vals = tracks.map((t) => t.energy ?? 5);
  if (vals.every((v) => v === vals[0])) return vals.map(() => 5); // no signal — keep the arc neutral
  const order = tracks.map((t, i) => [i, vals[i]]).sort((a, b) => a[1] - b[1]);
  const out = new Array(n).fill(5);
  order.forEach(([i], rank) => {
    out[i] = n > 1 ? 1 + Math.round((rank / (n - 1)) * 9) : 5;
  });
  return out;
}

// How jarring it is to play b right after a: key clash + tempo jump + energy jump.
function pairCost(a, b) {
  return (
    1.0 * (1 - camelotCompat(a.camelot, b.camelot)) +
    1.2 * bpmDistance(a.bpm, b.bpm) +
    0.6 * (Math.abs((a.energy ?? 5) - (b.energy ?? 5)) / 9)
  );
}

// Where to slot a newly added track into an already-ordered list without moving
// anything else: the position (lo..hi inclusive; p = "before list[p]", list.length =
// "at the end") that adds the least transition cost.
export function bestInsertIndex(list, track, lo = 0, hi = list.length) {
  let best = hi;
  let bestCost = Infinity;
  for (let p = lo; p <= hi; p++) {
    const prev = list[p - 1];
    const next = list[p];
    let cost = 0;
    if (prev) cost += pairCost(prev, track);
    if (next) cost += pairCost(track, next);
    if (prev && next) cost -= pairCost(prev, next);
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best;
}

// Party-session order for the upcoming tracks: higher net votes first. Within equal
// votes, `smooth` chains them greedily for the best mix starting from `prev` (the track
// before them); otherwise their current (e.g. hand-picked) order is kept.
export function voteOrder(prev, tracks, scoreOf, { smooth = true } = {}) {
  const groups = new Map();
  for (const t of tracks) {
    const s = scoreOf(t) || 0;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(t);
  }
  const out = [];
  let last = prev;
  for (const s of [...groups.keys()].sort((a, b) => b - a)) {
    const left = groups.get(s).slice();
    while (left.length) {
      let pick = 0;
      if (smooth && last) {
        let best = Infinity;
        left.forEach((t, i) => {
          const c = pairCost(last, t);
          if (c < best) {
            best = c;
            pick = i;
          }
        });
      }
      last = left.splice(pick, 1)[0];
      out.push(last);
    }
  }
  return out;
}

// Greedy harmonic path from a low-energy opener, biased to follow a rising-then-
// easing energy arc. Returns the reordered tracks + per-transition quality.
export function orderForParty(tracks, opts = {}) {
  const wKey = opts.wKey ?? 1.0;
  const wBpm = opts.wBpm ?? 1.2;
  const wEnergy = opts.wEnergy ?? 0.6;
  const list = tracks.slice();
  if (list.length <= 2) return { ordered: list, transitions: pairwise(list) };

  const n = list.length;
  const rel = relativeEnergies(list); // relative 1-10 (robust to noisy absolute energy)
  const peakPos = Math.max(1, Math.round(n * 0.7)); // energy peaks ~70% through

  // Opener = lowest (relative) energy track (warm-up).
  let start = 0;
  for (let i = 1; i < n; i++) if (rel[i] < rel[start]) start = i;

  const used = new Set([start]);
  const order = [start];
  while (order.length < n) {
    const curIdx = order[order.length - 1];
    const cur = list[curIdx];
    const dir = order.length < peakPos ? 1 : -1; // rise to peak, then ease down
    const targetE = clamp(rel[curIdx] + dir, 1, 10);
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue;
      const cost =
        wKey * (1 - camelotCompat(cur.camelot, list[i].camelot)) +
        wBpm * bpmDistance(cur.bpm, list[i].bpm) +
        wEnergy * (Math.abs(targetE - rel[i]) / 9);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    if (best < 0) {
      // Pathological costs (all NaN/Infinity) — fall back to the first unused track
      // so we never push -1 (which would drop/duplicate a track).
      for (let i = 0; i < n; i++)
        if (!used.has(i)) {
          best = i;
          break;
        }
    }
    used.add(best);
    order.push(best);
  }

  const ordered = order.map((i) => list[i]);
  return { ordered, transitions: pairwise(ordered) };
}
