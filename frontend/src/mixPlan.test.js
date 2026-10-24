import { describe, expect, it } from "vitest";
import { describePlan, planTransition, shiftCamelot } from "./mixPlan";

// A song on a 120 BPM grid (beat 0.5 s, bar 2 s) with its first downbeat at 0.3 s.
const song = (over = {}) => ({
  grid: { bpm: 120, downbeat: 0.3 },
  duration: 240,
  bigParts: [
    [60.3, 90.3],
    [140.3, 170.3],
  ],
  outroStart: 220,
  camelot: "8A",
  ...over,
});
const onDownbeat = (t, bpm, down) => {
  const bar = 240 / bpm;
  const r = (((t - down) % bar) + bar) % bar;
  return Math.min(r, bar - r) < 1e-6;
};

describe("planTransition", () => {
  it("blends whole phrases, leaving as the chorus ends and landing the next drop on the one", () => {
    const inc = song({ grid: { bpm: 122, downbeat: 0.1 }, bigParts: [[31.6, 60]] });
    const p = planTransition({ out: song(), inc, pos: 30, blendSecs: 16 });
    expect(p.style).toBe("blend");
    expect(p.beats).toBe(32); // 16 s at 120 BPM
    expect(p.outEnd).toBeCloseTo(90.3, 6); // the outgoing chorus ends exactly here
    expect(p.outStart).toBeCloseTo(90.3 - 16, 6);
    expect(onDownbeat(p.outStart, 120, 0.3)).toBe(true);
    // incoming plays at the outgoing tempo, and is at its drop when the blend ends
    expect(p.incRate).toBeCloseTo(120 / 122, 9);
    expect(p.lands).toBe("drop");
    const incBeat = 60 / 122;
    const dropAtEnd = p.inStart + p.beats * incBeat;
    expect(onDownbeat(dropAtEnd, 122, 0.1)).toBe(true);
    expect(Math.abs(dropAtEnd - 31.6)).toBeLessThan(incBeat * 2); // nearest downbeat to the drop
    expect(onDownbeat(p.inStart, 122, 0.1)).toBe(true);
    expect(p.swapBeat).toBe(16); // bass swap on a bar line, halfway
  });

  it("shortens the blend to fit a short intro, still landing on the drop", () => {
    const inc = song({ bigParts: [[8.3, 40]] }); // drop 4 bars in
    const p = planTransition({ out: song(), inc, pos: 30, blendSecs: 16 });
    expect(p.beats).toBe(16);
    expect(p.lands).toBe("drop");
    expect(p.inStart).toBeCloseTo(0.3, 6); // its very first downbeat
  });

  it("starts from the first downbeat when there's no early drop", () => {
    const inc = song({ bigParts: [] });
    const p = planTransition({ out: song(), inc, pos: 30, blendSecs: 16 });
    expect(p.lands).toBe("start");
    expect(p.inStart).toBeCloseTo(0.3, 6);
    expect(p.beats).toBe(32);
  });

  it("doesn't mistake a song's opening bars or one long section for a drop", () => {
    const early = planTransition({ out: song(), inc: song({ bigParts: [[4.3, 60]] }), pos: 30 });
    expect(early.lands).toBe("start");
    expect(early.beats).toBe(32);
    const whole = planTransition({ out: song(), inc: song({ bigParts: [[20.3, 235]] }), pos: 30 });
    expect(whole.lands).toBe("start");
  });

  it("keeps a clash it can't fix short, under a filter sweep", () => {
    const p = planTransition({ out: song(), inc: song({ camelot: "2B" }), pos: 30 });
    expect(p.style).toBe("filter");
    expect(p.keyShift).toBe(0);
    expect(p.beats).toBe(8);
    expect(p.swapBeat).toBe(4);
  });

  it("key-shifts a clash that's a semitone from fitting", () => {
    // 8A -> 2A clashes; 2A a semitone down (7A) or up (9A) sits right next to 8A.
    const p = planTransition({ out: song(), inc: song({ camelot: "2A" }), pos: 30 });
    expect(Math.abs(p.keyShift)).toBe(1);
    expect(p.style).toBe("blend");
    expect(p.beats).toBe(32);
    // ...and a key-shifted outgoing song is matched on the key it's heard in.
    const q = planTransition({ out: song({ camelot: "2A", keyShift: 1 }), inc: song(), pos: 30 });
    expect(q.keyShift).toBe(0);
  });

  it("treats a semitone up (+7 on the wheel) as an energy boost, not a clash", () => {
    const p = planTransition({ out: song(), inc: song({ camelot: "3A" }), pos: 30 });
    expect(p.keyShift).toBe(0);
    expect(p.style).toBe("blend");
  });

  it("loops a short quiet intro so the drop still lands on the one", () => {
    // Drop 2 bars in, after a quiet 2-bar intro: loop those bars for a 32-beat blend.
    const inc = song({ bigParts: [[4.3, 40]], introEnd: 4.3 });
    const p = planTransition({ out: song(), inc, pos: 30 });
    expect(p.lands).toBe("drop");
    expect(p.loop).toEqual({ start: 0.3, len: 4, count: 3 });
    expect(p.inStart).toBeCloseTo(0.3, 6);
    expect(p.beats).toBe(32); // 2 bars of intro + 3 looped 2-bar passes
  });

  it("cuts on the one into a vocal song that opens loud with no drop to aim for", () => {
    const out = song({ genre: "Reggaeton" });
    const inc = song({ genre: "Reggaeton", bigParts: [], introEnd: 0.3 });
    const p = planTransition({ out, inc, pos: 30 });
    expect(p.style).toBe("cut");
    expect(p.outEnd).toBeCloseTo(90.3, 6); // still leaves as the chorus ends, on a downbeat
    expect(p.outEnd - p.outStart).toBeCloseTo(0.5, 6); // the last beat echoes
    expect(p.echo).toEqual({ delayBeats: 0.5, feedback: 0.35 });
    expect(p.incRate).toBe(1);
  });

  it("caps the overlap of two vocal-led songs at 4 bars", () => {
    const out = song({ genre: "Pop" });
    const inc = song({ genre: "Reggaeton", bigParts: [[30.3, 60]] });
    const p = planTransition({ out, inc, pos: 30, blendSecs: 16 });
    expect(p.beats).toBe(16);
    expect(p.style).toBe("filter"); // a genre change gets the filter sweep
  });

  it("filter-sweeps across a big energy jump", () => {
    const p = planTransition({ out: song({ energy: 2 }), inc: song({ energy: 8 }), pos: 30 });
    expect(p.style).toBe("filter");
  });

  it("double-drops two electronic tracks: drops together, bass swapped on the drop", () => {
    const out = song({ genre: "House", bigParts: [[60.3, 90.3], [140.3, 170.3]] });
    const inc = song({ genre: "House", grid: { bpm: 121, downbeat: 0.3 }, bigParts: [[64.3, 90]] });
    const p = planTransition({ out, inc, pos: 30 });
    expect(p.style).toBe("double");
    expect(p.swapBeat).toBe(32);
    const drop = p.outStart + p.swapBeat * 0.5; // outgoing beat = 0.5 s
    expect(drop).toBeCloseTo(60.3, 6); // the outgoing drop...
    // ...meets the incoming drop, snapped to the incoming song's own downbeat
    const incBar = (4 * 60) / 121;
    const incDrop = p.inStart + 32 * (60 / 121);
    expect(incDrop).toBeCloseTo(0.3 + Math.round((64.3 - 0.3) / incBar) * incBar, 6);
    expect(p.outEnd - drop).toBeCloseTo(8, 6); // outgoing gone 4 bars after the drop
  });

  it("echoes out when the tempos are too far apart to beat-match", () => {
    const inc = song({ grid: { bpm: 100, downbeat: 0.2 }, bigParts: [[20.2, 50]] });
    const p = planTransition({ out: song(), inc, pos: 30 });
    expect(p.style).toBe("echo");
    expect(p.incRate).toBe(1); // no speed change
    expect(p.outEnd - p.outStart).toBeCloseTo(2, 6); // the last bar echoes
    expect(p.inStart).toBeCloseTo(19.4, 6); // straight into its drop, snapped to its downbeat
  });

  it("treats half / double time as a match", () => {
    const inc = song({ grid: { bpm: 240, downbeat: 0.05 } });
    const p = planTransition({ out: song(), inc, pos: 30 });
    expect(p.style).toBe("blend");
    expect(p.incRate).toBeCloseTo(1, 9);
  });

  it("matches the tempo the floor hears when the outgoing deck is sped up", () => {
    const inc = song({ grid: { bpm: 124, downbeat: 0.1 } });
    const p = planTransition({ out: song(), inc, pos: 30, rate: 1.02 });
    expect(p.incRate).toBeCloseTo((120 * 1.02) / 124, 9);
  });

  it("mixes across the outro when party mode is off", () => {
    const p = planTransition({ out: song(), inc: song(), pos: 30, party: false });
    expect(p.outStart).toBeCloseTo(220.3, 6); // outro start, on a downbeat
    expect(p.outEnd).toBeLessThanOrEqual(240);
  });

  it("Mix now starts on the next downbeat", () => {
    const p = planTransition({ out: song(), inc: song(), pos: 45.1, now: true });
    expect(onDownbeat(p.outStart, 120, 0.3)).toBe(true);
    expect(p.outStart).toBeGreaterThanOrEqual(45.1 + 0.4);
    expect(p.outStart).toBeLessThan(45.1 + 0.4 + 2);
  });

  it("never plans to start in the past or end after the song", () => {
    const p = planTransition({ out: song(), inc: song(), pos: 85 }); // past the chorus-end plan
    expect(p.outStart).toBeGreaterThan(85);
    const late = planTransition({ out: song({ bigParts: [[200, 239]] }), inc: song(), pos: 30 });
    expect(late.outEnd).toBeLessThanOrEqual(165); // party cap
  });

  it("falls back to a fade without a beat grid", () => {
    const p = planTransition({ out: song({ grid: null }), inc: song(), pos: 30 });
    expect(p.style).toBe("fade");
    expect(p.incRate).toBe(1);
    expect(p.outEnd - p.outStart).toBeCloseTo(4, 6);
  });
});

describe("shiftCamelot", () => {
  it("moves 7 steps round the wheel per semitone", () => {
    expect(shiftCamelot("8A", 1)).toBe("3A");
    expect(shiftCamelot("8A", -1)).toBe("1A");
    expect(shiftCamelot("12B", 1)).toBe("7B");
    expect(shiftCamelot("8A", 0)).toBe("8A");
    expect(shiftCamelot(null, 1)).toBe(null);
  });
});

describe("describePlan", () => {
  it("says what kind of transition is coming", () => {
    expect(describePlan({ style: "blend", beats: 32, lands: "drop" })).toBe("8-bar blend into the drop");
    expect(describePlan({ style: "short", beats: 8, lands: "start" })).toBe("2-bar quick blend");
    expect(describePlan({ style: "echo", lands: "drop" })).toBe("Echo out into the drop");
    expect(describePlan({ style: "fade" })).toBe("Fade");
    expect(describePlan({ style: "double", lands: "drop" })).toBe("Double drop");
    expect(describePlan({ style: "cut" })).toBe("Cut on the one");
    expect(describePlan({ style: "filter", beats: 16, lands: "start" })).toBe("4-bar filter sweep");
    expect(describePlan({ style: "blend", beats: 32, lands: "drop", loop: {}, keyShift: -1 })).toBe(
      "8-bar blend into the drop (intro looped) · key −1"
    );
  });
});
