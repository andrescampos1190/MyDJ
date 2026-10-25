// Where to mix out of a track, and how loud to play it. Pure functions (no audio) so
// they're easy to unit-test.

// Party mode plays each song through its first big part (chorus / drop) that ends past
// half the song and past MIN_PLAY — usually the second chorus, 1:45-3:00 into a typical
// song — and never longer than MAX_PLAY. (Leaving after the first chorus that ended past
// a minute cut songs off around 1:10.)
export const PARTY_MIN_PLAY = 90;
export const PARTY_SHARE = 0.5;
export const PARTY_MAX_PLAY = 180;
// ...except that a chorus running up to this much past MAX_PLAY gets to finish: cutting
// it a bar or two short sounds worse than playing a few seconds more.
const PARTY_GRACE = 10;

// The big part party mode leaves after (from the backend's `bigParts` [[start, end],
// ...] seconds), or undefined.
function leavePart(bigParts, dur, minPlay) {
  const from = Math.max(minPlay, PARTY_SHARE * dur);
  return (bigParts || []).find(([, end]) => end >= from);
}

// When party mode wants a song gone: the end of that big part; with no detected
// structure, ~60% in.
export function partyLeaveAt(
  bigParts,
  dur,
  { minPlay = PARTY_MIN_PLAY, maxPlay = PARTY_MAX_PLAY } = {},
) {
  const part = leavePart(bigParts, dur, minPlay);
  if (!part) return Math.min(Math.max(minPlay, dur * 0.6), maxPlay);
  return part[1] <= maxPlay + PARTY_GRACE ? part[1] : maxPlay;
}

// "Party" mix-out: start blending over the tail of that big part, instead of playing
// to the end — no third verses or long outros. Always leaves room for the blend.
// Returns seconds, or null if the duration is unknown.
export function partyMixOut(
  bigParts,
  dur,
  { blend = 16, minPlay = PARTY_MIN_PLAY, maxPlay = PARTY_MAX_PLAY } = {},
) {
  if (!(dur > 0)) return null;
  const latest = Math.max(1, Math.min(maxPlay, dur - blend));
  const end = partyLeaveAt(bigParts, dur, { minPlay, maxPlay });
  const part = leavePart(bigParts, dur, minPlay);
  // Start blending before the big part ends, so the next track's energy takes over as
  // it finishes rather than after the floor has already dropped.
  if (part && part[1] === end)
    return Math.min(Math.max(part[0], end - blend / 2), latest);
  return Math.min(end, latest);
}

// Volume matching: gain (dB) that brings a track's integrated loudness (LUFS) to
// `target`. Boosts are capped — quiet masters would otherwise slam the limiter.
export function matchGainDb(
  lufs,
  { target = -11, maxBoost = 4, maxCut = 12 } = {},
) {
  if (!Number.isFinite(lufs)) return 0;
  return Math.max(-maxCut, Math.min(maxBoost, target - lufs));
}
