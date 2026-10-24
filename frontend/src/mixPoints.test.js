import { describe, expect, it } from "vitest";
import { partyMixOut } from "./mixPoints";

// Build a 100-point energy curve from [fromPct, toPct, level] sections.
function curve(sections) {
  const c = new Array(100).fill(0.5);
  for (const [a, b, v] of sections) for (let i = a; i < b; i++) c[i] = v;
  return c;
}

describe("partyMixOut", () => {
  // 240 s pop song: intro, verse, chorus 1 (60-90 s), verse, chorus 2 (135-165 s), outro.
  const pop = curve([
    [0, 8, 0.2],
    [8, 25, 0.55],
    [25, 38, 0.95],
    [38, 56, 0.55],
    [56, 69, 1],
    [69, 100, 0.4],
  ]);

  it("mixes out over the tail of the first big part that ends after minPlay", () => {
    const at = partyMixOut(pop, 240, { blend: 16 }); // chorus 1 ends at 91.2 s
    expect(at).toBeCloseTo(91.2 - 8, 1);
  });

  it("skips big parts that end too early", () => {
    const at = partyMixOut(pop, 240, { blend: 16, minPlay: 120 }); // chorus 2 ends at 165.6 s
    expect(at).toBeCloseTo(165.6 - 8, 1);
  });

  it("bridges a one-point dip inside a chorus", () => {
    const dipped = pop.slice();
    dipped[30] = 0.6;
    expect(partyMixOut(dipped, 240, { blend: 16 })).toBeCloseTo(91.2 - 8, 1);
  });

  it("caps play time when there's no clear big moment", () => {
    expect(partyMixOut(new Array(100).fill(0.5), 400, { blend: 16 })).toBe(210);
    expect(partyMixOut(new Array(100).fill(0.5), 120, { blend: 16 })).toBe(104); // dur - blend
  });

  it("always leaves room for the blend before the track ends", () => {
    const late = curve([[80, 100, 1]]);
    expect(partyMixOut(late, 200, { blend: 16 })).toBe(184);
  });

  it("returns null without analysis", () => {
    expect(partyMixOut([], 200)).toBeNull();
    expect(partyMixOut(null, 200)).toBeNull();
  });
});
