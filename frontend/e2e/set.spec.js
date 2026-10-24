import { expect, test } from "@playwright/test";
import { MEDIA_PORT } from "../playwright.config.js";

const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;

// Peak level on the master bus over ~0.5 s — proves sound is actually coming out,
// not just that the UI says "playing". Uses the dev-only window.engine hook.
async function masterPeak(page) {
  return page.evaluate(async () => {
    const e = window.engine;
    const an = e.ctx.createAnalyser();
    e.master.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 50));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
    e.master.disconnect(an);
    return peak;
  });
}

test("add tracks, order them, and auto-mix from one to the next", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");

  const tracks = [
    ["G_major", "9B"],
    ["A_minor", "8A"],
    ["C_major", "8B"],
  ];
  for (const [name, camelot] of tracks) {
    await page.locator(".loadbar input").fill(`${MEDIA}/${name}.mp3`);
    await page.locator(".loadbar button").click();
    const row = page.locator(".tracks li", { hasText: name });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.locator(".chip.key")).toContainText(camelot);
  }
  await expect(page.locator(".error")).toHaveCount(0);

  await page.getByRole("button", { name: /Order for Party/ }).click();
  await expect(page.locator(".xbadge")).toHaveCount(2); // a transition badge between each pair

  // 4 s blend on 24 s tracks: mix out at ~20 s, then ~16 s of steady play on track 2.
  // (With the default 16 s blend, track 2 is already past its mix-out point when the
  // handoff completes, so the mixer rightly blends straight on into track 3.)
  await page.locator(".pl-controls input[type=range]").fill("4");
  await expect(page.locator(".pl-controls .val")).toHaveText("4s");
  await page.getByRole("button", { name: /Start Set/ }).click();

  const status = page.locator(".playlist .status");
  await expect(status).toContainText("playing · 1/3", { timeout: 30_000 });
  expect(await masterPeak(page)).toBeGreaterThan(0.05);

  await expect(status).toContainText("mixing", { timeout: 30_000 });
  await expect(status).toContainText("playing · 2/3", { timeout: 30_000 });
  const decks = await page.evaluate(() => ({
    a: window.engine.deckA.isPlaying,
    b: window.engine.deckB.isPlaying,
  }));
  expect(decks.a !== decks.b).toBe(true); // exactly one deck left playing after the handoff
  expect(await masterPeak(page)).toBeGreaterThan(0.05);

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: /Start Set/ })).toBeVisible();
  expect(errors).toEqual([]);
});
