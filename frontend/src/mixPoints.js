// Where to mix out of a track, and how loud to play it. Pure functions (no audio) so
// they're easy to unit-test.

// Party mode plays each song through its first big part (chorus / drop) that ends past
// half the song and past MIN_PLAY — usually the second chorus, 1:45-3:00 into a typical
// song — and never longer than MAX_PLAY. (Leaving after the first chorus that ended past
// a minute cut songs off around 1:10.)
export const PARTY_MIN_PLAY = 90;
export const PARTY_SHARE = 0.5;
export const PARTY_MAX_PLAY = 180;

// When party mode wants a song gone: the end of the big part described above (from the
// backend's `bigParts` [[start, end], ...] seconds); with no detected structure, ~60% in.
export function partyLeaveAt(
  bigParts,
  dur,
  { minPlay = PARTY_MIN_PLAY, maxPlay = PARTY_MAX_PLAY } = {},
) {
  const from = Math.max(minPlay, PARTY_SHARE * dur);
  const part = (bigParts || []).find(([, end]) => end >= from);
  return Math.min(part ? part[1] : Math.max(minPlay, dur * 0.6), maxPlay);
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
  const part = (bigParts || []).find(([, e]) => e === end);
  // Start blending before the big part ends, so the next track's energy takes over as
  // it finishes rather than after the floor has already dropped.
  if (part) return Math.min(Math.max(part[0], end - blend / 2), latest);
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
