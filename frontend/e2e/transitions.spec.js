import { expect, test } from "@playwright/test";
import { MEDIA_PORT } from "../playwright.config.js";

const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
// The grooves' true grids (see backend/tests/serve_media.py) — ground truth, not the
// app's own detection.
const TRUTH = {
  groove_122: { bpm: 122.0, down: 0.4 },
  groove_125: { bpm: 125.4, down: 0.9 },
  groove_100: { bpm: 100.0, down: 0.2 },
};

async function load(page, names) {
  await page.goto("/");
  for (const name of names) {
    await page.getByLabel("Search a song or paste a link").fill(`${MEDIA}/${name}.mp3`);
    await page.getByLabel("Search a song or paste a link").press("Enter");
    await expect(page.locator(".tracks li", { hasText: name })).toBeVisible({ timeout: 60_000 });
  }
  const rows = page.locator(".tracks li");
  if (!(await rows.nth(0).textContent()).includes(names[0]))
    await rows.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(rows.nth(0)).toContainText(names[0]);
  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  await expect(page.locator(".set-status")).toContainText("Live · song 1 of 2", { timeout: 30_000 });
}

test("a beat-matched blend stays locked to the beat, then glides back to the song's own tempo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await load(page, ["groove_122", "groove_125"]);
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText("-bar blend", { timeout: 10_000 });

  await now.getByRole("button", { name: /Mix now/ }).click();
  await expect(page.locator(".set-status")).toContainText("Mixing", { timeout: 3_000 });

  // Through the blend: how far apart are the two songs' beats and bars, on their TRUE grids?
  const { samples, plan } = await page.evaluate(async (truth) => {
    const e = window.engine;
    const out = [];
    const circ = (x) => x - Math.round(x); // signed distance to the nearest whole number
    for (let i = 0; i < 60 && e.auto.status === "transitioning"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const [a, b] = [e.deckA, e.deckB];
      if (!a.isPlaying || !b.isPlaying) continue;
      // The incoming song is scheduled to start on a downbeat: skip until it has.
      if (e.ctx.currentTime < Math.max(a._startCtxTime, b._startCtxTime)) continue;
      const ta = truth[a.meta.title];
      const tb = truth[b.meta.title];
      const beatsA = (a.position() - ta.down) / (60 / ta.bpm);
      const beatsB = (b.position() - tb.down) / (60 / tb.bpm);
      const heardBeat = 60 / (ta.bpm * a.playbackRate); // seconds per beat on the floor
      out.push({
        ms: Math.abs(circ(beatsA - beatsB)) * heardBeat * 1000,
        bars: Math.abs(circ((beatsA - beatsB) / 4)),
      });
    }
    return { samples: out, plan: e.auto._lastPlan };
  }, TRUTH);

  expect(plan.style).toBe("blend");
  expect(plan.beats).toBe(32);
  expect(samples.length).toBeGreaterThan(20);
  const worstMs = Math.max(...samples.map((s) => s.ms));
  console.log(`beat alignment over ${samples.length} samples: worst ${worstMs.toFixed(2)} ms`);
  expect(worstMs).toBeLessThan(6); // a flam becomes audible around 10-20 ms
  expect(Math.max(...samples.map((s) => s.bars))).toBeLessThan(0.01); // downbeats line up too

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
