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

test("add a song mid-set and make it play next", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");

  const add = async (name) => {
    await page.locator(".loadbar input").fill(`${MEDIA}/${name}.mp3`);
    await page.locator(".loadbar button").click();
    await expect(page.locator(".tracks li", { hasText: name })).toBeVisible({ timeout: 60_000 });
  };
  await add("G_major");
  await add("A_minor");

  await page.locator(".pl-controls input[type=range]").fill("4");
  await page.getByRole("button", { name: /Start Set/ }).click();
  const status = page.locator(".playlist .status");
  await expect(status).toContainText("playing · 1/2", { timeout: 30_000 });
  const rows = page.locator(".tracks li");
  const first = (await rows.nth(0).locator(".t-title").textContent()).trim();
  const queuedNext = (await rows.nth(1).locator(".t-title").textContent()).trim();

  // Adding works while the set plays; it can't jump ahead of the preloaded next track.
  await add("C_major");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("C_major");
  await expect(rows.nth(0).locator(".tag.now")).toBeVisible();
  await expect(rows.nth(1).locator(".tag")).toHaveText("NEXT");

  // "Next" bumps it ahead of the preloaded track.
  await rows.nth(2).getByRole("button", { name: /Next/ }).click();
  await expect(rows.nth(1)).toContainText("C_major");
  await expect(rows.nth(1).locator(".tag")).toHaveText("NEXT");
  await expect(rows.nth(2)).toContainText(queuedNext);

  // The mixer actually transitions into it.
  await expect(status).toContainText("playing · 2/3", { timeout: 40_000 });
  await expect(rows.nth(1).locator(".tag.now")).toBeVisible();
  const playing = await page.evaluate(() => {
    const e = window.engine;
    return [e.deckA, e.deckB].find((d) => d.isPlaying)?.meta?.title;
  });
  expect(playing).toBe("C_major");
  expect(first).not.toBe("C_major");

  await page.getByRole("button", { name: /Stop/ }).click();
  expect(errors).toEqual([]);
});

test("party mode mixes out after the big chorus, not at the end", async ({ page }) => {
  await page.goto("/");
  for (const name of ["G_major", "party_song"]) {
    await page.locator(".loadbar input").fill(`${MEDIA}/${name}.mp3`);
    await page.locator(".loadbar button").click();
    await expect(page.locator(".tracks li", { hasText: name })).toBeVisible({ timeout: 60_000 });
  }
  const rows = page.locator(".tracks li");
  if (!(await rows.nth(0).textContent()).includes("party_song")) {
    await rows.nth(1).getByRole("button", { name: "▲" }).click(); // manual reorder
  }
  await expect(rows.nth(0)).toContainText("party_song");
  await expect(page.getByRole("button", { name: /Party mode: ON/ })).toBeVisible();

  await page.getByRole("button", { name: /Start Set/ }).click();
  const status = page.locator(".playlist .status");
  await expect(status).toContainText("playing · 1/2", { timeout: 30_000 });
  // party_song: big chorus 20-75 s, final chorus 90-120 s. Jump near the first one's end.
  await page.evaluate(() => window.engine.seek(window.engine.deckA.isPlaying ? "A" : "B", 55));

  await expect(status).toContainText("mixing", { timeout: 30_000 });
  const pos = await page.evaluate(() => {
    const e = window.engine;
    return [e.deckA, e.deckB].find((d) => d.meta?.title === "party_song").position();
  });
  expect(pos).toBeGreaterThan(65); // tail of the first chorus (~67.6 s)...
  expect(pos).toBeLessThan(80); // ...not ~104 s, where playing it to the end would mix out
  await page.getByRole("button", { name: /Stop/ }).click();
});
