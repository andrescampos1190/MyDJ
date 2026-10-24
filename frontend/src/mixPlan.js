// Transition planning, the way a club DJ does it. Pure functions (no audio): the
// engine executes the plan on the audio clock.
//
//  - Phrasing: the outgoing song leaves on a downbeat — in party mode right as its big
//    part (chorus / drop) ends, otherwise across its outro — and the blend is a whole
//    number of bars (8 / 16 / 32 beats).
//  - Drop on the one: the incoming song enters on its own downbeat, timed so its first
//    big part lands exactly when the outgoing one is gone. Overlap happens under the
//    incoming intro, not two choruses (and two vocals) at once.
//  - Style per pair: a long EQ blend when tempo and key agree, a short 2-bar blend when
//    the keys clash, an echo-out when the tempos are too far apart to beat-match, and a
//    plain fade when there's no reliable beat grid.

import { bpmDistance, camelotCompat } from "./ordering";
import { partyMixOut } from "./mixPoints";

const LEAD = 0.4; // s: schedule at least this far ahead on the audio clock
const MIN_PLAY = 60; // party mode: leave after the first big part ending past this...
const MAX_PLAY = 165; // ...and never later than this
const MAX_GAP = 0.08; // tempo gap beyond which beat-matching sounds wrong (pitch / speed)
const FADE_SECS = 4;

function gridOf(t) {
  const g = t?.grid;
  if (!g?.bpm || !Number.isFinite(g.downbeat)) return null;
  const beat = 60 / g.bpm;
  return { bpm: g.bpm, beat, bar: 4 * beat, down: g.downbeat };
}
const atOrAfter = (G, x) => G.down + Math.ceil((x - G.down - 1e-6) / G.bar) * G.bar;
const nearest = (G, x) => G.down + Math.round((x - G.down) / G.bar) * G.bar;
const firstDownbeat = (G) => G.down - Math.floor(G.down / G.bar + 1e-9) * G.bar; // earliest >= 0

// Where the outgoing song should be gone (track seconds, on a downbeat).
function outEnd({ out, G, pos, rate, span, party, now }) {
  const dur = out.duration;
  const earliest = pos + LEAD * rate + span; // the blend can't start in the past
  if (now) return atOrAfter(G, earliest);
  let target;
  if (party) {
    const part = (out.bigParts || []).find(([, end]) => end >= MIN_PLAY);
    target = part ? part[1] : Math.max(MIN_PLAY, dur * 0.6);
    target = Math.min(target, MAX_PLAY);
  } else {
    const outro = out.outroStart > 0 && out.outroStart < dur ? out.outroStart : dur;
    target = Math.min(outro + span, dur);
  }
  let E = nearest(G, target);
  while (E > dur - 0.25) E -= G.bar; // the song has to still be playing
  if (E < earliest) E = atOrAfter(G, earliest);
  return E;
}

// Where the incoming song should be "at full" when the blend ends: its first big part
// (chorus / drop), if that's a real drop — after an intro of at least 4 bars, a distinct
// section rather than most of the song — and comes early enough to make sense.
function landing(inc, G, party) {
  const first = (inc.bigParts || [])[0];
  if (!first) return null;
  const [start, end] = first;
  const limit = party ? 120 : 45; // party mode happily skips to the good part
  const dur = inc.duration || Infinity;
  if (start < firstDownbeat(G) + 4 * G.bar - 1e-6) return null; // no intro to blend over
  if (end - start > 0.6 * dur) return null; // one long section isn't a "drop"
  if (start > limit) return null;
  return nearest(G, start);
}

/**
 * @param out  outgoing track {grid, duration, bigParts, outroStart, camelot}
 * @param inc  incoming track {grid, duration, bigParts, introEnd, camelot}
 * @param pos  outgoing position now (track seconds)
 * @param rate outgoing playbackRate (the tempo the floor hears is grid.bpm * rate)
 * @returns {style, outStart, outEnd, beats, swapBeat, inStart, incRate, lands}
 *   outStart/outEnd/inStart in track seconds; beats/swapBeat in outgoing beats.
 */
export function planTransition({ out, inc, pos, rate = 1, blendSecs = 16, party = true, now = false }) {
  const Go = gridOf(out);
  const Gi = gridOf(inc);

  if (!Go || !Gi) {
    // No reliable beat grid: a smooth equal-power fade, no beat-matching.
    const secs = Math.min(FADE_SECS, blendSecs);
    let start;
    if (now) start = pos + LEAD * rate;
    else if (party) start = partyMixOut(out.bigParts, out.duration, { blend: secs });
    else start = Math.min(out.outroStart > 0 ? out.outroStart : out.duration, out.duration) - secs;
    start = Math.max(start ?? 0, pos + LEAD * rate);
    return {
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
  if (bpmDistance(heard, Gi.bpm) > MAX_GAP) {
    // Echo out: the last beat of the outgoing song repeats and fades while the
    // incoming one drops in on the downbeat at its own tempo.
    const E = outEnd({ out, G: Go, pos, rate, span: Go.bar, party, now });
    const L = landing(inc, Gi, party);
    return {
      style: "echo",
      outStart: E - Go.bar,
      outEnd: E,
      beats: 4,
      swapBeat: 4,
      inStart: L ?? firstDownbeat(Gi),
      incRate: 1,
      lands: L != null ? "drop" : "start",
    };
  }

  // Beat-matched blend. Half / double time counts as a match (e.g. 87 into 174).
  const k = Math.round(Math.log2(Gi.bpm / heard));
  const incRate = (heard * 2 ** k) / Gi.bpm;
  const incBeatsPerOutBeat = 2 ** k;
  const beatHeard = 60 / heard;
  const clash = camelotCompat(out.camelot, inc.camelot) < 0.4;
  let beats = [32, 16, 8].find((n) => n * beatHeard <= Math.max(blendSecs, 8 * beatHeard));
  if (clash) beats = Math.min(beats, 8); // keep a harmonic clash short

  // Fit the incoming lead-in: shorten the blend (down to 2 bars) so the drop can land on
  // the one; if even that doesn't fit, start the incoming song from its first downbeat.
  const L = landing(inc, Gi, party);
  let inStart = null;
  let lands = "start";
  if (L != null) {
    for (let n = beats; n >= 8; n /= 2) {
      const s = L - n * incBeatsPerOutBeat * Gi.beat;
      if (s >= -1e-6) {
        beats = n;
        inStart = Math.max(0, s);
        lands = "drop";
        break;
      }
    }
  }
  if (inStart == null) inStart = firstDownbeat(Gi);

  const span = beats * Go.beat; // outgoing track seconds covered by the blend
  const E = outEnd({ out, G: Go, pos, rate, span, party, now });
  return {
    style: beats <= 8 ? "short" : "blend",
    outStart: E - span,
    outEnd: E,
    beats,
    swapBeat: Math.max(4, Math.round(beats / 8) * 4), // a bar line, halfway through
    inStart,
    incRate,
    lands,
  };
}

// For the UI: "16-bar blend into the drop", "Echo out", ...
export function describePlan(p) {
  if (!p) return "";
  if (p.style === "fade") return "Fade";
  if (p.style === "echo") return `Echo out${p.lands === "drop" ? " into the drop" : ""}`;
  const bars = p.beats / 4;
  return `${bars}-bar ${p.style === "short" ? "quick blend" : "blend"}${p.lands === "drop" ? " into the drop" : ""}`;
}
