// Transition planning, the way a club DJ does it. Pure functions (no audio): the
// engine executes the plan on the audio clock.
//
//  - Phrasing: the outgoing song leaves on a downbeat — in party mode right as its big
//    part (chorus / drop) ends, otherwise across its outro — and the blend is a whole
//    number of bars (8 / 16 / 32 beats).
//  - Drop on the one: the incoming song enters on its own downbeat, timed so its first
//    big part lands exactly when the outgoing one is gone. Overlap happens under the
//    incoming intro, not two choruses (and two vocals) at once. A quiet intro too short
//    to blend over gets its first bars looped, as a DJ would with a radio edit.
//  - Style per pair (see planTransition): EQ blend, double drop, filter sweep, cut on
//    the one, echo-out, or a plain fade without a beat grid. Keys that clash but are a
//    semitone away from fitting get the incoming song key-shifted.
//  - Vocals: once a song is split into stems the planner knows where its vocals are.
//    Two singers never overlap — with both songs' stems on the decks, the outgoing
//    vocal drops out on the bar line where the incoming one comes in (a vocal swap).

import { bpmDistance, camelotCompat } from "./ordering";
import {
  PARTY_MAX_PLAY,
  PARTY_MIN_PLAY,
  PARTY_SHARE,
  partyLeaveAt,
  partyMixOut,
} from "./mixPoints";

const LEAD = 0.4; // s: schedule at least this far ahead on the audio clock
const MAX_GAP = 0.08; // tempo gap beyond which beat-matching sounds wrong (pitch / speed)
const DOUBLE_GAP = 0.04; // double drops need near-identical tempos
const FADE_SECS = 4;
const VOCAL_BLEND_BEATS = 16; // two vocal-led songs: overlap at most 4 bars
const VOCAL_SHARE = 0.15; // vocals over this share of a song make it vocal-led

// Genres whose songs are vocal-led (open-format mixing: short blends and cuts) — the
// stand-in until a song's stems say where its vocals actually are — and genres built
// for long DJ blends and double drops.
const VOCAL_GENRES = new Set([
  "Reggaeton",
  "Hip-Hop",
  "Pop",
  "Latin",
  "Bachata",
  "Salsa",
  "Cumbia",
  "Merengue",
  "Corridos",
  "Dancehall",
  "Afrobeats",
  "K-Pop",
  "R&B",
  "Rock",
]);
const ELECTRONIC = new Set([
  "House",
  "Tech House",
  "Deep House",
  "Progressive House",
  "Afro House",
  "Techno",
  "Trance",
  "EDM",
  "Drum & Bass",
  "Dubstep",
]);

function gridOf(t) {
  const g = t?.grid;
  if (!g?.bpm || !Number.isFinite(g.downbeat)) return null;
  const beat = 60 / g.bpm;
  return { bpm: g.bpm, beat, bar: 4 * beat, down: g.downbeat };
}
const atOrAfter = (G, x) =>
  G.down + Math.ceil((x - G.down - 1e-6) / G.bar) * G.bar;
const nearest = (G, x) => G.down + Math.round((x - G.down) / G.bar) * G.bar;
const firstDownbeat = (G) => G.down - Math.floor(G.down / G.bar + 1e-9) * G.bar; // earliest >= 0

// The Camelot code a song sounds in after shifting it by `semis` semitones
// (+1 semitone = +7 on the wheel).
export function shiftCamelot(code, semis) {
  const m = /^(\d{1,2})([AB])$/.exec(String(code || "").trim());
  if (!m || !semis) return code || null;
  const n = (((parseInt(m[1], 10) - 1 + 7 * semis) % 12) + 12) % 12;
  return `${n + 1}${m[2]}`;
}

// Whole bars of quiet intro (before the song's first sustained loud part) from its first
// downbeat, up to `upTo` — the part of a song a DJ can loop or blend over.
function quietIntroBars(inc, G, upTo = Infinity) {
  const end = Math.min(inc.introEnd ?? 0, upTo);
  return Math.max(0, Math.floor((end - firstDownbeat(G)) / G.bar + 1e-6));
}

// Where the outgoing song should be gone (track seconds, on a downbeat).
function outEnd({ out, G, pos, rate, span, party, now }) {
  const dur = out.duration;
  const earliest = pos + LEAD * rate + span; // the blend can't start in the past
  if (now) return atOrAfter(G, earliest);
  let target;
  if (party) {
    target = partyLeaveAt(out.bigParts, dur);
  } else {
    const outro =
      out.outroStart > 0 && out.outroStart < dur ? out.outroStart : dur;
    target = Math.min(outro + span, dur);
  }
  let E = nearest(G, target);
  while (E > dur - 0.25) E -= G.bar; // the song has to still be playing
  if (E < earliest) E = atOrAfter(G, earliest);
  return E;
}

// Where the incoming song should be "at full" when the blend ends: its first big part
// (chorus / drop), if that's a real drop — a distinct section rather than most of the
// song, after an intro worth blending over (4+ bars, or a quiet bar or two to loop) —
// and comes early enough to make sense.
function landing(inc, G, party) {
  const first = (inc.bigParts || [])[0];
  if (!first) return null;
  const [start, end] = first;
  const d0 = firstDownbeat(G);
  const limit = party ? 120 : 45; // party mode happily skips to the good part
  const dur = inc.duration || Infinity;
  if (start < d0 + G.bar - 1e-6) return null; // the song opens on it
  if (end - start > 0.6 * dur) return null; // one long section isn't a "drop"
  if (start > limit) return null;
  if (start < d0 + 4 * G.bar - 1e-6 && quietIntroBars(inc, G, start) < 1)
    return null;
  return nearest(G, start);
}

// Vocals: t.vocals = [[start, end], ...] (track seconds) once the song is separated,
// otherwise unknown and the genre stands in.
const knowsVocals = (t) => Array.isArray(t.vocals);
const MIN_VOX = 0.3; // s: a vocal overlapping a stretch by less than this is just its edge
const vocalsIn = (t, a, b) =>
  (t.vocals || []).some(([s, e]) => Math.min(e, b) - Math.max(s, a) > MIN_VOX);
function isVocal(t) {
  if (!knowsVocals(t)) return VOCAL_GENRES.has(t.genre);
  const secs = t.vocals.reduce((n, [s, e]) => n + (e - s), 0);
  return secs >= VOCAL_SHARE * (t.duration || Infinity);
}

// The vocal swap: the first bar of the blend where the incoming vocals sing while the
// outgoing ones still have lines to come — the outgoing vocal goes, the incoming one
// comes in, right on that bar line. null when the vocals never meet.
function vocalSwap(plan, out, inc, Go, Gi, kk) {
  if (!knowsVocals(out) || !knowsVocals(inc)) return null;
  const incBeat = kk * Gi.beat; // incoming track seconds per outgoing beat
  const lp = plan.loop;
  const incAt = (b) => {
    const t = b * incBeat;
    if (!lp) return plan.inStart + t;
    const looped = lp.count * lp.len;
    return t < looped ? lp.start + (t % lp.len) : lp.start + (t - looped);
  };
  for (let b = 0; b < plan.beats; b += 4) {
    if (!vocalsIn(inc, incAt(b), incAt(b) + 4 * incBeat)) continue;
    return vocalsIn(out, plan.outStart + b * Go.beat, plan.outEnd) ? b : null;
  }
  return null;
}

const base = { loop: null, keyShift: 0, echo: null, vocalSwap: null };

/**
 * @param out  outgoing track {grid, duration, bigParts, outroStart, camelot, keyShift,
 *             genre, energy, vocals, stems}
 * @param inc  incoming track {grid, duration, bigParts, introEnd, camelot, genre, energy,
 *             vocals, stems} — vocals: [[start, end], ...] or unknown; stems: true when
 *             the deck plays it as vocal + instrumental stems (vocals can be switched)
 * @param pos  outgoing position now (track seconds)
 * @param rate outgoing playbackRate (the tempo the floor hears is grid.bpm * rate)
 * @returns {style, outStart, outEnd, beats, swapBeat, inStart, incRate, lands, loop,
 *   keyShift, echo, vocalSwap}: outStart/outEnd/inStart in track seconds; beats/swapBeat
 *   in outgoing beats; loop = {start, len, count} (incoming intro loop, track seconds);
 *   keyShift = semitones to shift the incoming song; echo = {delayBeats, feedback};
 *   vocalSwap = the beat (from outStart) where the vocals hand over, or null.
 */
export function planTransition({
  out,
  inc,
  pos,
  rate = 1,
  blendSecs = 16,
  party = true,
  now = false,
}) {
  const Go = gridOf(out);
  const Gi = gridOf(inc);

  if (!Go || !Gi) {
    // No reliable beat grid: a smooth equal-power fade, no beat-matching.
    const secs = Math.min(FADE_SECS, blendSecs);
    let start;
    if (now) start = pos + LEAD * rate;
    else if (party)
      start = partyMixOut(out.bigParts, out.duration, { blend: secs });
    else
      start =
        Math.min(
          out.outroStart > 0 ? out.outroStart : out.duration,
          out.duration,
        ) - secs;
    start = Math.max(start ?? 0, pos + LEAD * rate);
    return {
      ...base,
      style: "fade",
      outStart: start,
      outEnd: start + secs * rate,
      beats: null,
      swapBeat: null,
      inStart: Math.max(0, inc.introEnd || 0),
      incRate: 1,
      lands: "start",
    };
  }

  const heard = Go.bpm * rate; // outgoing tempo as heard
  const gap = bpmDistance(heard, Gi.bpm);
  const d0 = firstDownbeat(Gi);
  const L = landing(inc, Gi, party);

  if (gap > MAX_GAP) {
    // Echo out: the last beat of the outgoing song repeats and fades while the
    // incoming one drops in on the downbeat at its own tempo.
    const E = outEnd({ out, G: Go, pos, rate, span: Go.bar, party, now });
    return {
      ...base,
      style: "echo",
      outStart: E - Go.bar,
      outEnd: E,
      beats: 4,
      swapBeat: 4,
      inStart: L ?? d0,
      incRate: 1,
      lands: L != null ? "drop" : "start",
      echo: { delayBeats: 1, feedback: 0.5 },
    };
  }

  // Keys: what the floor hears from the outgoing song (it may itself be key-shifted).
  // A clash that's a semitone away from fitting gets the incoming song shifted.
  const outKey = shiftCamelot(out.camelot, out.keyShift || 0);
  let keyShift = 0;
  let compat = camelotCompat(outKey, inc.camelot);
  if (compat < 0.6 && outKey && inc.camelot) {
    for (const s of [-1, 1]) {
      const c = camelotCompat(outKey, shiftCamelot(inc.camelot, s));
      if (c >= 0.9) {
        keyShift = s;
        compat = c;
        break;
      }
    }
  }
  const clash = compat < 0.4;
  const vocalPair = isVocal(out) && isVocal(inc);
  const canSwap =
    !!(out.stems && inc.stems) && knowsVocals(out) && knowsVocals(inc);
  // Bars the incoming song plays before its vocals come in (known from its stems), or,
  // until then, its quiet intro.
  const room = knowsVocals(inc)
    ? Math.floor(((inc.vocals[0]?.[0] ?? Infinity) - d0) / Gi.bar + 1e-6)
    : quietIntroBars(inc, Gi);

  // Cut on the one: a vocal-led song with nothing to blend over (its vocals start right
  // away and it has no drop to aim for) — a short echo and a clean drop on the downbeat
  // beats two vocals on top of each other. With both songs' stems a vocal swap does it.
  if (L == null && isVocal(inc) && room < 1 && !canSwap) {
    const E = outEnd({ out, G: Go, pos, rate, span: Go.beat, party, now });
    return {
      ...base,
      style: "cut",
      outStart: E - Go.beat,
      outEnd: E,
      beats: 1,
      swapBeat: 1,
      inStart: d0,
      incRate: 1,
      lands: "start", // no overlap, so no key clash to fix
      echo: { delayBeats: 0.5, feedback: 0.35 },
    };
  }

  // Beat-matched from here. Half / double time counts as a match (e.g. 87 into 174).
  const k = Math.round(Math.log2(Gi.bpm / heard));
  const incRate = (heard * 2 ** k) / Gi.bpm;
  const kk = 2 ** k; // incoming beats per outgoing beat
  const beatHeard = 60 / heard;
  let beats = [32, 16, 8].find(
    (n) => n * beatHeard <= Math.max(blendSecs, 8 * beatHeard),
  );
  if (clash) beats = Math.min(beats, 8); // keep a harmonic clash short
  if (vocalPair && !canSwap) beats = Math.min(beats, VOCAL_BLEND_BEATS);

  // Double drop: two electronic tracks, same key family and tempo — line both drops up,
  // swap the basslines right on the drop, then take the outgoing one away over 4 bars.
  if (
    ELECTRONIC.has(out.genre) &&
    ELECTRONIC.has(inc.genre) &&
    compat >= 0.9 &&
    gap <= DOUBLE_GAP &&
    k === 0 &&
    L != null &&
    !now
  ) {
    const run = Math.min(beats, 32);
    const inStart = L - run * Gi.beat;
    const lead = pos + LEAD * rate + run * Go.beat;
    const drop = (out.bigParts || [])
      .map(([s]) => nearest(Go, s))
      .find(
        (D) =>
          D >= lead &&
          (!party ||
            (D + 16 * Go.beat >=
              Math.max(PARTY_MIN_PLAY, PARTY_SHARE * out.duration) &&
              D <= PARTY_MAX_PLAY)),
      );
    if (
      inStart >= d0 - 1e-6 &&
      drop != null &&
      drop + 16 * Go.beat <= out.duration - 0.25
    ) {
      const plan = {
        ...base,
        style: "double",
        outStart: drop - run * Go.beat,
        outEnd: drop + 16 * Go.beat,
        beats: run + 16,
        swapBeat: run,
        inStart,
        incRate,
        lands: "drop",
        keyShift,
      };
      if (canSwap) plan.vocalSwap = vocalSwap(plan, out, inc, Go, Gi, kk);
      return plan;
    }
  }

  // Fit the incoming lead-in so its drop lands on the one: use its intro; if that's too
  // short, loop its first quiet bar or two for room; failing that, shorten the blend.
  let inStart = null;
  let lands = "start";
  let loop = null;
  if (L != null) {
    const need = beats * kk * Gi.beat;
    const avail = L - d0;
    if (avail + 1e-6 >= need) {
      inStart = L - need;
      lands = "drop";
    } else if (k === 0 && quietIntroBars(inc, Gi, L) >= 1) {
      const len = (quietIntroBars(inc, Gi, L) >= 2 ? 2 : 1) * Gi.bar;
      const count = Math.ceil((need - avail) / len - 1e-6);
      loop = { start: d0, len, count };
      inStart = d0;
      lands = "drop";
      beats = Math.round((avail + count * len) / Gi.beat);
    } else {
      for (let n = beats / 2; n >= 8; n /= 2) {
        const s = L - n * kk * Gi.beat;
        if (s >= -1e-6) {
          beats = n;
          inStart = Math.max(0, s);
          lands = "drop";
          break;
        }
      }
    }
  }
  if (inStart == null) inStart = d0;

  // A filter sweep smooths a change of genre or energy, and hides a clash we can't fix.
  const genreChange = out.genre && inc.genre && out.genre !== inc.genre;
  const energyJump = Math.abs((out.energy ?? 5) - (inc.energy ?? 5)) >= 4;
  const style =
    clash || genreChange || energyJump
      ? "filter"
      : beats <= 8
        ? "short"
        : "blend";

  const span = beats * Go.beat; // outgoing track seconds covered by the blend
  const E = outEnd({ out, G: Go, pos, rate, span, party, now });
  const plan = {
    ...base,
    style,
    outStart: E - span,
    outEnd: E,
    beats,
    swapBeat: Math.max(4, Math.round(beats / 8) * 4), // a bar line, halfway through
    inStart,
    incRate,
    lands,
    loop,
    keyShift,
  };
  if (canSwap) plan.vocalSwap = vocalSwap(plan, out, inc, Go, Gi, kk);
  return plan;
}

// For the UI: "8-bar blend into the drop", "Double drop", "Cut on the one", ...
export function describePlan(p) {
  if (!p) return "";
  const drop = p.lands === "drop" ? " into the drop" : "";
  let s;
  if (p.style === "fade") s = "Fade";
  else if (p.style === "echo") s = `Echo out${drop}`;
  else if (p.style === "cut") s = "Cut on the one";
  else if (p.style === "double") s = "Double drop";
  else if (p.style === "filter") s = `${p.beats / 4}-bar filter sweep${drop}`;
  else
    s = `${p.beats / 4}-bar ${p.style === "short" ? "quick blend" : "blend"}${drop}`;
  if (p.loop) s += " (intro looped)";
  if (p.vocalSwap != null) s += " · vocal swap";
  if (p.keyShift) s += ` · key ${p.keyShift > 0 ? "+" : "−"}1`;
  return s;
}
