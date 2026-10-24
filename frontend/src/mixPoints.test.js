import { describe, expect, it } from "vitest";
import { matchGainDb, partyMixOut } from "./mixPoints";

describe("partyMixOut", () => {
  // 240 s pop song: chorus 1 at 60-90 s, chorus 2 at 135-165 s.
  const pop = [
    [60, 90],
    [135, 165],
  ];

  it("mixes out over the tail of the first big part that ends after minPlay", () => {
    expect(partyMixOut(pop, 240, { blend: 16 })).toBe(82);
  });

  it("skips big parts that end too early", () => {
    expect(partyMixOut([[20, 45], ...pop], 240, { blend: 16 })).toBe(82);
    expect(partyMixOut(pop, 240, { blend: 16, minPlay: 120 })).toBe(157);
  });

  it("never starts the blend before the big part does", () => {
    expect(partyMixOut([[58, 62]], 240, { blend: 16 })).toBe(58);
  });

  it("leaves ~60% in when there's no detected structure", () => {
    expect(partyMixOut([], 200, { blend: 16 })).toBe(120);
    expect(partyMixOut(undefined, 80, { blend: 16 })).toBe(60); // at least minPlay...
    expect(partyMixOut([], 50, { blend: 16 })).toBe(34); // ...but room for the blend
  });

  it("caps play time and always leaves room for the blend", () => {
    expect(partyMixOut([[150, 230]], 400, { blend: 16 })).toBe(165);
    expect(partyMixOut([[160, 200]], 200, { blend: 16 })).toBe(165);
    expect(partyMixOut([[100, 120]], 120, { blend: 16 })).toBe(104);
  });

  it("returns null without a duration", () => {
    expect(partyMixOut(pop, 0)).toBeNull();
    expect(partyMixOut(pop, undefined)).toBeNull();
  });
});

describe("matchGainDb", () => {
  it("brings tracks to the target loudness", () => {
    expect(matchGainDb(-8)).toBe(-3); // loud master: turned down
    expect(matchGainDb(-11)).toBe(0);
    expect(matchGainDb(-14)).toBe(3); // quiet one: turned up
  });

  it("caps boosts and cuts, and ignores unknown loudness", () => {
    expect(matchGainDb(-25)).toBe(4);
    expect(matchGainDb(5)).toBe(-12);
    expect(matchGainDb(null)).toBe(0);
    expect(matchGainDb(undefined)).toBe(0);
  });
});
