import { describe, expect, it } from "vitest";
import { matchGainDb, partyLeaveAt, partyMixOut } from "./mixPoints";

describe("partyLeaveAt", () => {
  // Real song (Tito "El Bambino" - Chequea Cómo Se Siente, 3:28): its first chorus ends
  // at 1:08 — leaving there cut it short; the one ending past half-way is at 2:39.
  const chequea = [
    [33.47, 68.14],
    [78.8, 100.14],
    [124.14, 158.8],
    [169.47, 182.8],
  ];

  it("plays through the first big part that ends past half the song", () => {
    expect(partyLeaveAt(chequea, 208)).toBe(158.8);
  });

  it("and past 1:30, on short songs", () => {
    expect(
      partyLeaveAt(
        [
          [40, 70],
          [80, 100],
          [110, 130],
        ],
        150,
      ),
    ).toBe(100);
  });

  it("lets a chorus that ends just past 3 minutes finish", () => {
    // Real song (Don Omar - Dutty Love, 4:46): its chorus ends at 3:01.
    const dutty = [
      [33.35, 51.35],
      [67.35, 117.34],
      [141.34, 181.34],
      [205.34, 259.33],
    ];
    expect(partyLeaveAt(dutty, 286)).toBe(181.34);
    expect(partyMixOut(dutty, 286, { blend: 16 })).toBeCloseTo(173.34, 6); // blend over its tail
  });

  it("never more than 3 minutes", () => {
    expect(
      partyLeaveAt(
        [
          [120, 150],
          [200, 240],
        ],
        335,
      ),
    ).toBe(180);
  });

  it("~60% in without detected structure", () => {
    expect(partyLeaveAt([], 200)).toBe(120);
    expect(partyLeaveAt(null, 120)).toBe(90); // at least 1:30
  });
});

describe("partyMixOut", () => {
  // 240 s pop song: chorus 1 at 60-90 s, chorus 2 at 135-165 s.
  const pop = [
    [60, 90],
    [135, 165],
  ];

  it("mixes out over the tail of the big part party mode leaves after", () => {
    expect(partyMixOut(pop, 240, { blend: 16 })).toBe(157);
  });

  it("never starts the blend before the big part does", () => {
    expect(partyMixOut([[118, 124]], 240, { blend: 16 })).toBe(118);
  });

  it("leaves ~60% in when there's no detected structure", () => {
    expect(partyMixOut([], 200, { blend: 16 })).toBe(120);
    expect(partyMixOut(undefined, 100, { blend: 16 })).toBe(84); // room for the blend
  });

  it("caps play time and always leaves room for the blend", () => {
    expect(partyMixOut([[150, 230]], 400, { blend: 16 })).toBe(180);
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
