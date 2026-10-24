// Where to mix out of a track, and how loud to play it. Pure functions (no audio) so
// they're easy to unit-test.

// "Party" mix-out: leave over the tail of the track's first big part (chorus / drop,
// detected by the backend as `bigParts` [[start, end], ...] seconds) that ends after
// `minPlay`, instead of playing to the end — no second verses or long outros. With no
// detected structure, leave ~60% in. Never past `maxPlay`, and always leave room for
// the blend. Returns seconds, or null if the duration is unknown.
export function partyMixOut(bigParts, dur, { blend = 16, minPlay = 60, maxPlay = 165 } = {}) {
  if (!(dur > 0)) return null;
  const latest = Math.max(1, Math.min(maxPlay, dur - blend));
  for (const [start, end] of bigParts || []) {
    // Start blending before the big part ends, so the next track's energy takes over
    // as it finishes rather than after the floor has already dropped.
    if (end >= minPlay) return Math.min(Math.max(start, end - blend / 2), latest);
  }
  return Math.min(Math.max(minPlay, dur * 0.6), latest);
}

// Volume matching: gain (dB) that brings a track's integrated loudness (LUFS) to
// `target`. Boosts are capped — quiet masters would otherwise slam the limiter.
export function matchGainDb(lufs, { target = -11, maxBoost = 4, maxCut = 12 } = {}) {
  if (!Number.isFinite(lufs)) return 0;
  return Math.max(-maxCut, Math.min(maxBoost, target - lufs));
}
