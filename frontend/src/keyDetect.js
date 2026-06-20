// Client-side musical key detection via essentia.js (HPCP-based KeyExtractor).
// More accurate than the backend's hand-rolled Krumhansl-Schmuckler fallback —
// notably it gets the major/minor (Camelot A vs B) right far more often.
// essentia.js is AGPL-3.0; fine for local/personal use.

const NOTE_PC = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const CAMELOT_MAJ = { 0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
  6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B" };
const CAMELOT_MIN = { 9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A",
  3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A" };

function toCamelot(key, scale) {
  const pc = NOTE_PC[key];
  if (pc == null) return null;
  const isMinor = /min/i.test(scale);
  return (isMinor ? CAMELOT_MIN : CAMELOT_MAJ)[pc] || null;
}

let _essentia = null;
function getEssentia() {
  if (!_essentia) {
    _essentia = (async () => {
      // Lazy + dynamic import so the ~heavy WASM only loads on first analysis.
      const [wasmMod, coreMod] = await Promise.all([
        import("essentia.js/dist/essentia-wasm.es.js"),
        import("essentia.js/dist/essentia.js-core.es.js"),
      ]);
      let wasm = wasmMod.EssentiaWASM;
      if (typeof wasm === "function") wasm = await wasm(); // emscripten factory
      else if (wasm && typeof wasm.then === "function") wasm = await wasm;
      return new coreMod.default(wasm);
    })().catch((e) => {
      _essentia = null; // allow retry on next track
      throw e;
    });
  }
  return _essentia;
}

// Plain-JS mono downmix — avoids essentia.audioBufferToMonoSignal, which leaks
// three internal VectorFloats per call (unreachable from outside, so unfreeable).
function toMono(audioBuffer) {
  const ch0 = audioBuffer.getChannelData(0);
  if (audioBuffer.numberOfChannels < 2) return ch0;
  const ch1 = audioBuffer.getChannelData(1);
  const out = new Float32Array(ch0.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (ch0[i] + ch1[i]);
  return out;
}

// Returns { key: "A minor", camelot: "8A", strength } or null. Frees every WASM
// allocation in `finally` so the essentia heap stays flat across a long set.
export async function detectKey(audioBuffer) {
  let vec = null;
  let r = null;
  try {
    const essentia = await getEssentia();
    const sr = audioBuffer.sampleRate;
    let mono = toMono(audioBuffer);
    if (mono.length > sr * 120) {
      const mid = Math.floor(mono.length / 2);
      mono = mono.subarray(mid - sr * 45, mid + sr * 45);
    }
    vec = essentia.arrayToVector(mono);
    // KeyExtractor(audio, avgDetune, frame, hop, hpcpSize, maxFreq, maxPeaks,
    //   minFreq, pcpThreshold, profileType, sampleRate, peaksThresh, tuning, weight, window)
    r = essentia.KeyExtractor(
      vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, "bgate", sr, 0.0001, 440, "cosine", "hann"
    );
    if (!r || !r.key) return null;
    const camelot = toCamelot(r.key, r.scale);
    return camelot ? { key: `${r.key} ${r.scale}`, camelot, strength: r.strength } : null;
  } catch {
    return null; // fall back to the backend key
  } finally {
    try {
      if (r && r.delete) r.delete();
    } catch {
      /* noop */
    }
    try {
      if (vec && vec.delete) vec.delete();
    } catch {
      /* noop */
    }
  }
}
