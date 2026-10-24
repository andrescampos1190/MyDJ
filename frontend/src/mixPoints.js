// Where to mix out of a track. Pure functions (no audio) so they're easy to unit-test.

const PEAK = 0.8; // near-peak energy (curve is RMS normalized to the track's loud level)

// "Party" mix-out: leave right after the track's big moment (the first sustained
// near-peak section — chorus / drop — that ends after `minPlay` s) instead of playing
// it to the end, so the floor never sits through second verses and long outros.
// `curve` = the backend's ~100-point energy curve; returns seconds, or null if unknown.
export function partyMixOut(curve, dur, { blend = 16, minPlay = 60, maxPlay = 210 } = {}) {
  if (!curve?.length || !(dur > 0)) return null;
  const n = curve.length;
  const step = dur / n;
  const latest = Math.max(1, Math.min(maxPlay, dur - blend)); // the blend must end before the track does
  // Near-peak points, bridging single-point dips (a snare fill shouldn't split a chorus).
  const hot = curve.map(
    (v, i) => v >= PEAK || (i > 0 && i < n - 1 && curve[i - 1] >= PEAK && curve[i + 1] >= PEAK)
  );
  const minLen = Math.max(2, Math.round(12 / step)); // >= ~12 s counts as "the big part"
  for (let i = 0; i < n; ) {
    if (!hot[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && hot[j]) j++;
    const start = i * step;
    const end = j * step;
    if (j - i >= minLen && end >= minPlay) {
      // Start blending over the tail of the big part, so the next track's energy takes
      // over as it ends rather than after the floor has already dropped.
      const at = Math.max(start, end - blend / 2, Math.min(minPlay, latest));
      return Math.min(at, latest);
    }
    i = j;
  }
  return latest; // no clear big moment: still don't overstay
}
