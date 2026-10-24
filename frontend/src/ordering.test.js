import { describe, expect, it } from "vitest";
import {
  bestInsertIndex,
  bpmDistance,
  camelotCompat,
  orderForParty,
  relativeEnergies,
  transitionQuality,
} from "./ordering";

describe("camelotCompat", () => {
  it("scores harmonic relationships", () => {
    expect(camelotCompat("8A", "8A")).toBe(1);
    expect(camelotCompat("8A", "8B")).toBe(0.9); // relative major/minor
    expect(camelotCompat("8A", "9A")).toBe(0.9);
    expect(camelotCompat("12A", "1A")).toBe(0.9); // wraps around the wheel
    expect(camelotCompat("8A", "10A")).toBe(0.6); // energy boost (+2)
    expect(camelotCompat("8A", "2B")).toBe(0.2); // clash
  });

  it("is neutral when a key is unknown", () => {
    expect(camelotCompat(null, "8A")).toBe(0.5);
    expect(camelotCompat("8A", "garbage")).toBe(0.5);
  });
});

describe("bpmDistance", () => {
  it("is zero for equal and half/double tempos", () => {
    expect(bpmDistance(124, 124)).toBe(0);
    expect(bpmDistance(87, 174)).toBe(0);
    expect(bpmDistance(174, 87)).toBe(0);
  });

  it("grows with tempo gap and tolerates missing BPM", () => {
    expect(bpmDistance(120, 126)).toBeCloseTo(0.0488, 3);
    expect(bpmDistance(null, 120)).toBe(0.3);
    expect(bpmDistance(0, 120)).toBe(0.3);
  });
});

describe("transitionQuality", () => {
  it("labels perfect and rough transitions", () => {
    const a = { camelot: "8A", bpm: 124, energy: 5 };
    expect(transitionQuality(a, { camelot: "9A", bpm: 125, energy: 6 })).toMatchObject({
      label: "perfect",
      energyStep: 1,
    });
    expect(transitionQuality(a, { camelot: "2B", bpm: 160, energy: 5 }).label).toBe("rough");
  });
});

describe("relativeEnergies", () => {
  it("spreads ranks across 1-10", () => {
    expect(relativeEnergies([{ energy: 9 }, { energy: 2 }, { energy: 5 }])).toEqual([10, 1, 6]);
  });

  it("stays neutral when every track has the same energy", () => {
    expect(relativeEnergies([{ energy: 7 }, { energy: 7 }])).toEqual([5, 5]);
    expect(relativeEnergies([])).toEqual([]);
  });
});

describe("orderForParty", () => {
  const set = [
    { id: "peak", camelot: "9A", bpm: 128, energy: 9 },
    { id: "opener", camelot: "8A", bpm: 122, energy: 2 },
    { id: "build", camelot: "8A", bpm: 124, energy: 5 },
    { id: "clash", camelot: "3B", bpm: 90, energy: 6 },
    { id: "mid", camelot: "9A", bpm: 126, energy: 7 },
  ];

  it("keeps every track exactly once", () => {
    const { ordered, transitions } = orderForParty(set);
    expect(ordered.map((t) => t.id).sort()).toEqual(set.map((t) => t.id).sort());
    expect(transitions).toHaveLength(set.length - 1);
  });

  it("opens low and builds harmonically", () => {
    const ids = orderForParty(set).ordered.map((t) => t.id);
    expect(ids.slice(0, 3)).toEqual(["opener", "build", "mid"]);
  });

  it("never drops tracks with missing analysis", () => {
    const blank = Array.from({ length: 6 }, (_, i) => ({ id: String(i) }));
    expect(orderForParty(blank).ordered).toHaveLength(6);
  });

  it("leaves two-track lists alone", () => {
    expect(orderForParty(set.slice(0, 2)).ordered).toEqual(set.slice(0, 2));
  });
});

describe("bestInsertIndex", () => {
  const set = [
    { id: "a", camelot: "8A", bpm: 122, energy: 3 },
    { id: "b", camelot: "9A", bpm: 124, energy: 5 },
    { id: "c", camelot: "3B", bpm: 95, energy: 6 },
  ];

  it("slots a track between its closest harmonic/tempo neighbours", () => {
    const t = { camelot: "8A", bpm: 123, energy: 4 };
    expect(bestInsertIndex(set, t)).toBe(1); // between a (8A/122) and b (9A/124)
  });

  it("respects the allowed range", () => {
    const t = { camelot: "8A", bpm: 123, energy: 4 };
    expect(bestInsertIndex(set, t, 2, 3)).toBe(2); // best spot still left in 2..3
    expect(bestInsertIndex(set, t, 3, 3)).toBe(3);
  });

  it("goes to the end of an empty list", () => {
    expect(bestInsertIndex([], { camelot: "8A" })).toBe(0);
  });
});
