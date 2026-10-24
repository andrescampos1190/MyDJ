import { expect, test } from "@playwright/test";
import { MEDIA_PORT, STEMS_WEB_PORT } from "../playwright.config.js";

const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
// The grooves' true grids (see backend/tests/serve_media.py) — ground truth, not the
// app's own detection.
const TRUTH = {
  groove_122: { bpm: 122.0, down: 0.4 },
  groove_125: { bpm: 125.4, down: 0.9 },
  groove_100: { bpm: 100.0, down: 0.2 },
  groove_eb: { bpm: 124.0, down: 0.6 },
  intro_song: { bpm: 124.0, down: 0.3 },
  drop_a: { bpm: 124.0, down: 0.5 },
  drop_b: { bpm: 125.0, down: 0.2 },
  vocal_a: { bpm: 124.0, down: 0.5 },
  vocal_b: { bpm: 124.0, down: 0.3 },
};

// Add the songs, put names[0] first, optionally tag genres / turn Party mode off / wait
// for their vocals to be split, then start the set.
async function load(page, names, { genres, party = true, stems = false } = {}) {
  await page.goto("/");
  for (const name of names) {
    await page.getByLabel("Search a song or paste a link").fill(`${MEDIA}/${name}.mp3`);
    await page.getByLabel("Search a song or paste a link").press("Enter");
    await expect(page.locator(".tracks li", { hasText: name })).toBeVisible({ timeout: 60_000 });
  }
  if (stems)
    for (const name of names)
      await expect(page.locator(".tracks li", { hasText: name })).toContainText("🎤 vocals split", {
        timeout: 300_000,
      });
  const rows = page.locator(".tracks li");
  if (!(await rows.nth(0).textContent()).includes(names[0]))
    await rows.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(rows.nth(0)).toContainText(names[0]);
  if (genres)
    await page.evaluate((g) => {
      for (const t of window.engine.playlist) t.genre = g[t.title] ?? t.genre;
    }, genres);
  if (!party) await page.getByRole("switch", { name: /Party mode/ }).click();
  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  await expect(page.locator(".set-status")).toContainText("Live · song 1 of 2", { timeout: 30_000 });
}

// Through a transition: how far apart are the two songs' beats and bars, on their TRUE
// grids? (Deck.position() follows an intro loop, so looped beats count too.)
function alignment(page) {
  return page.evaluate(async (truth) => {
    const e = window.engine;
    const out = [];
    const circ = (x) => x - Math.round(x); // signed distance to the nearest whole number
    for (let i = 0; i < 160 && e.auto.status === "transitioning"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const [a, b] = [e.deckA, e.deckB];
      if (!a.isPlaying || !b.isPlaying) continue;
      // The incoming song is scheduled to start on a downbeat (or into its intro loop):
      // skip until it has.
      const from = (d) => (d._loop ? d._loop.when : d._startCtxTime);
      if (e.ctx.currentTime < Math.max(from(a), from(b))) continue;
      const ta = truth[a.meta.title];
      const tb = truth[b.meta.title];
      const beatsA = (a.position() - ta.down) / (60 / ta.bpm);
      const beatsB = (b.position() - tb.down) / (60 / tb.bpm);
      const heardBeat = 60 / (ta.bpm * a.playbackRate); // seconds per beat on the floor
      out.push({
        ms: Math.abs(circ(beatsA - beatsB)) * heardBeat * 1000,
        bars: Math.abs(circ((beatsA - beatsB) / 4)),
        looping: !!(a._loop || b._loop) && e.ctx.currentTime < (a._loop || b._loop).until,
      });
    }
    return { samples: out, plan: e.auto._lastPlan };
  }, TRUTH);
}

function expectLocked(samples) {
  expect(samples.length).toBeGreaterThan(10);
  const worstMs = Math.max(...samples.map((s) => s.ms));
  console.log(`beat alignment over ${samples.length} samples: worst ${worstMs.toFixed(2)} ms`);
  expect(worstMs).toBeLessThan(6); // a flam becomes audible around 10-20 ms
  expect(Math.max(...samples.map((s) => s.bars))).toBeLessThan(0.01); // downbeats line up too
}

const stop = (page) => page.locator(".topbar").getByRole("button", { name: /Stop/ }).click();

test("a beat-matched blend stays locked to the beat, then glides back to the song's own tempo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await load(page, ["groove_122", "groove_125"]);
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("-bar blend", { timeout: 10_000 });

  await now.getByRole("button", { name: /Mix now/ }).click();
  await expect(page.locator(".set-status")).toContainText("Mixing", { timeout: 3_000 });

  const { samples, plan } = await alignment(page);
  expect(plan.style).toBe("blend");
  expect(plan.beats).toBe(32);
  expect(samples.length).toBeGreaterThan(20);
  expectLocked(samples);

  // Handoff done: the new song starts at the old tempo (122/125.4 = 0.973 speed), then
  // glides back to its own tempo.
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 20_000 });
  const rate = () =>
    page.evaluate(() => {
      const e = window.engine;
      return e.deck(e.auto.front).playbackRate;
    });
  expect(await rate()).toBeLessThan(0.99);
  await expect.poll(rate, { timeout: 30_000, intervals: [1000] }).toBe(1);
  await page.locator(".topbar").getByRole("button", { name: /Stop/ }).click();
});

test("tempos too far apart: echo out, and the next song plays at its own tempo", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, ["groove_122", "groove_100"]);
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("Echo out", { timeout: 10_000 });

  await now.getByRole("button", { name: /Mix now/ }).click();
  // The last beat feeds the echo (sampled on the audio thread's current value).
  const echoed = await page.evaluate(async () => {
    const e = window.engine;
    const front = e.deck(e.auto.front);
    let max = 0;
    for (let i = 0; i < 200 && e.auto.status === "transitioning"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      max = Math.max(max, front.echoSend.gain.value);
    }
    return max;
  });
  expect(echoed).toBe(1);
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 10_000 });
  const rate = await page.evaluate(() => window.engine.deck(window.engine.auto.front).playbackRate);
  expect(rate).toBe(1);
  await page.locator(".topbar").getByRole("button", { name: /Stop/ }).click();
});

test("a 2-bar intro is looped so the blend still lands the drop, locked to the beat", async ({ page }) => {
  test.setTimeout(180_000);
  await load(page, ["groove_122", "intro_song"]);
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("(intro looped)", { timeout: 10_000 });
  await now.getByRole("button", { name: /Mix now/ }).click();
  const { samples, plan } = await alignment(page);
  // intro_song: 2 quiet bars from 0.3 s, then the drop at 4.17 s.
  expect(plan.loop.start).toBeCloseTo(0.3, 1);
  expect(plan.loop.count).toBeGreaterThan(1);
  expect(plan.beats).toBeGreaterThanOrEqual(16);
  expect(samples.some((s) => s.looping)).toBe(true);
  expectLocked(samples);
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 20_000 });
  // Out of the loop: the song plays on through its drop.
  const pos = await page.evaluate(() => window.engine.deck(window.engine.auto.front).position());
  expect(pos).toBeGreaterThan(4.17);
  await stop(page);
});

test("vocal songs with no intro to blend over: cut on the one", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, ["groove_122", "groove_125"], {
    genres: { groove_122: "Reggaeton", groove_125: "Reggaeton" },
  });
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("Cut on the one", { timeout: 10_000 });
  await now.getByRole("button", { name: /Mix now/ }).click();
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 10_000 });
  const r = await page.evaluate(() => {
    const e = window.engine;
    const p = e.auto._lastPlan;
    return { style: p.style, span: p.outEnd - p.outStart, rate: e.deck(e.auto.front).playbackRate };
  });
  expect(r.style).toBe("cut");
  expect(r.span).toBeLessThan(1); // a single beat, then the new song hits on the downbeat
  expect(r.rate).toBe(1);
  await stop(page);
});

test("a genre change gets a filter sweep: the outgoing song is low-passed away", async ({ page }) => {
  test.setTimeout(180_000);
  await load(page, ["groove_122", "groove_125"], {
    genres: { groove_122: "House", groove_125: "Techno" },
  });
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("filter sweep", { timeout: 10_000 });
  await now.getByRole("button", { name: /Mix now/ }).click();
  const sweep = await page.evaluate(async () => {
    const e = window.engine;
    const out = e.deck(e.auto.front);
    const inc = e.other(e.auto.front);
    let outMin = Infinity;
    let incMax = 0;
    for (let i = 0; i < 400 && e.auto.status === "transitioning"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (out.isPlaying) outMin = Math.min(outMin, out.filter.frequency.value);
      if (inc.filter.type === "highpass") incMax = Math.max(incMax, inc.filter.frequency.value);
    }
    return { outMin, incMax, style: e.auto._lastPlan.style };
  });
  expect(sweep.style).toBe("filter");
  expect(sweep.outMin).toBeLessThan(1000); // swept down from wide open
  expect(sweep.incMax).toBeGreaterThan(500); // the new song came in thin, then opened up
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 20_000 });
  await stop(page);
});

test("clashing keys: the next song is pitched a semitone to fit, still on the beat", async ({ page }) => {
  test.setTimeout(180_000);
  const shifted = [];
  page.on("request", (r) => {
    const m = r.url().match(/semitones=(-?\d)/);
    if (m) shifted.push(Number(m[1]));
  });
  await load(page, ["groove_122", "groove_eb"]); // A minor (8A) vs Eb minor (2A): a clash
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText(/key [+−]1/, { timeout: 30_000 });
  const before = await page.evaluate(() => {
    const e = window.engine;
    return { plan: e.auto.plan(), back: e.other(e.auto.front).keyShift };
  });
  expect(Math.abs(before.plan.keyShift)).toBe(1);
  expect(before.back).toBe(before.plan.keyShift);
  expect(shifted).toContain(before.plan.keyShift);

  await now.getByRole("button", { name: /Mix now/ }).click();
  const { samples, plan } = await alignment(page);
  expect(plan.style).not.toBe("filter"); // the shift fixed the clash
  expectLocked(samples); // pitching doesn't move the beats
  await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 20_000 });
  await stop(page);
});

test("two electronic tracks: a double drop lands both drops together", async ({ page }) => {
  test.setTimeout(180_000);
  await load(page, ["drop_a", "drop_b"], {
    genres: { drop_a: "House", drop_b: "House" },
    party: false,
  });
  // drop_a: drops at ~16 s and ~62.4 s. Jump into the break before the second one.
  await page.evaluate(() => window.engine.seek(window.engine.auto.front, 38));
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("Double drop", { timeout: 10_000 });

  // Let it trigger on its own, and catch the moment drop_a's second drop hits.
  await page.waitForFunction(() => window.engine.auto.status === "transitioning", null, {
    timeout: 30_000,
  });
  const { samples, plan } = await alignment(page);
  expect(plan.style).toBe("double");
  // Both drops on the same downbeat: drop_a's at 62.4 s is where drop_b's (~15.6 s) lands.
  const outDrop = plan.outStart + plan.swapBeat * (60 / 124);
  const incDrop = plan.inStart + plan.swapBeat * (60 / 125);
  expect(Math.abs(outDrop - 62.44)).toBeLessThan(0.1);
  expect(Math.abs(incDrop - 15.56)).toBeLessThan(0.1);
  expectLocked(samples);
  await stop(page);
});

test.describe("with vocal separation on", () => {
  test.use({ baseURL: `http://localhost:${STEMS_WEB_PORT}` });

  test("two singers: the vocals swap on the bar line, the beat stays locked", async ({ page }) => {
    test.setTimeout(480_000);
    const stemRequests = [];
    page.on("request", (r) => r.url().includes("/api/stems/") && stemRequests.push(r.url()));
    await load(page, ["vocal_a", "vocal_b"], { stems: true });
    const now = page.getByRole("region", { name: "Now playing" });
    await expect(now).toContainText("vocal swap", { timeout: 30_000 });
    // Both decks play the songs as stems (instrumental + vocals).
    expect(await page.evaluate(() => !!(window.engine.deckA.vocals && window.engine.deckB.vocals))).toBe(true);
    expect(stemRequests.some((u) => u.endsWith("/vocals"))).toBe(true);

    await now.getByRole("button", { name: /Mix now/ }).click();
    const [{ samples, plan }, vox] = await Promise.all([
      alignment(page),
      page.evaluate(async () => {
        const e = window.engine;
        const out = e.deck(e.auto.front);
        const inc = e.other(e.auto.front);
        const seen = [];
        for (let i = 0; i < 400 && e.auto.status === "transitioning"; i++) {
          await new Promise((r) => setTimeout(r, 50));
          if (out.isPlaying && inc.isPlaying && e.ctx.currentTime >= inc._startCtxTime)
            seen.push([out.vox.gain.value, inc.vox.gain.value]);
        }
        return seen;
      }),
    ]);
    // vocal_b sings from bar 2: the swap is there, 8 beats in.
    expect(plan.vocalSwap).toBe(8);
    expect(plan.beats).toBe(32); // a full-length blend, safe with the swap
    const before = vox.findIndex(([o, i]) => o === 1 && i === 0); // outgoing sings, incoming held
    const after = vox.findIndex(([o, i]) => o === 0 && i === 1); // handed over
    expect(before).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(before);
    expect(vox.slice(after).every(([o, i]) => o === 0 && i === 1)).toBe(true); // never both
    expectLocked(samples); // two stems per deck, still on the beat
    await expect(page.locator(".set-status")).toContainText("Live · song 2 of 2", { timeout: 20_000 });
    await stop(page);
  });
});
