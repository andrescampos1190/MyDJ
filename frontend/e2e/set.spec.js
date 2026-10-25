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
    await expect(row.locator(".t-meta")).toContainText(camelot);
  }
  await expect(page.locator(".error")).toHaveCount(0);

  await page.getByRole("button", { name: /Order for Party/ }).click();
  await expect(page.locator(".xbadge")).toHaveCount(2); // a transition badge between each pair

  // 4 s blend on 24 s tracks: mix out at ~20 s, then ~16 s of steady play on track 2.
  // (With the default 16 s blend, track 2 is already past its mix-out point when the
  // handoff completes, so the mixer rightly blends straight on into track 3.)
  await page.getByLabel("Blend length").fill("4");
  await expect(page.locator(".blend .val")).toHaveText("4s");
  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();

  const status = page.locator(".set-status");
  await expect(status).toContainText("Live · song 1 of 3", { timeout: 30_000 });
  expect(await masterPeak(page)).toBeGreaterThan(0.05);

  await expect(status).toContainText("Mixing", { timeout: 30_000 });
  await expect(status).toContainText("Live · song 2 of 3", { timeout: 30_000 });
  const decks = await page.evaluate(() => ({
    a: window.engine.deckA.isPlaying,
    b: window.engine.deckB.isPlaying,
  }));
  expect(decks.a !== decks.b).toBe(true); // exactly one deck left playing after the handoff
  expect(await masterPeak(page)).toBeGreaterThan(0.05);

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.locator(".topbar").getByRole("button", { name: /Start set/ })).toBeVisible();
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

  await page.getByLabel("Blend length").fill("4");
  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  const status = page.locator(".set-status");
  await expect(status).toContainText("Live · song 1 of 2", { timeout: 30_000 });
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
  await expect(status).toContainText("Live · song 2 of 3", { timeout: 40_000 });
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

test("party mode mixes out after the chorus that ends past half-way, not at the end", async ({ page }) => {
  await page.goto("/");
  for (const name of ["G_major", "party_song"]) {
    await page.locator(".loadbar input").fill(`${MEDIA}/${name}.mp3`);
    await page.locator(".loadbar button").click();
    await expect(page.locator(".tracks li", { hasText: name })).toBeVisible({ timeout: 60_000 });
  }
  const rows = page.locator(".tracks li");
  if (!(await rows.nth(0).textContent()).includes("party_song")) {
    await rows.nth(1).getByRole("button", { name: "Move up" }).click(); // manual reorder
  }
  await expect(rows.nth(0)).toContainText("party_song");
  await expect(page.getByRole("switch", { name: /Party mode/ })).toHaveAttribute("aria-checked", "true");

  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  const status = page.locator(".set-status");
  await expect(status).toContainText("Live · song 1 of 2", { timeout: 30_000 });
  // party_song (200 s): choruses at 20-60, 90-130 and 160-200 s. Jump into the second.
  await page.evaluate(() => window.engine.seek(window.engine.deckA.isPlaying ? "A" : "B", 105));

  await expect(status).toContainText("Mixing", { timeout: 30_000 });
  const pos = await page.evaluate(() => {
    const e = window.engine;
    return [e.deckA, e.deckB].find((d) => d.meta?.title === "party_song").position();
  });
  // The transition finishes as the second chorus ends at 130 s (on a downbeat), instead
  // of mixing out near the end by playing the song through.
  expect(pos).toBeGreaterThan(105);
  expect(pos).toBeLessThan(130);
  const outEnd = await page.evaluate(() => window.engine.auto._lastPlan.outEnd);
  expect(Math.abs(outEnd - 130)).toBeLessThan(1);
  await page.getByRole("button", { name: /Stop/ }).click();
});

test("volume match plays a loud and a quiet master at the same level", async ({ page }) => {
  await page.goto("/");
  // Output level (dB RMS, pre-limiter) of a track played alone on deck A.
  const level = (name) =>
    page.evaluate(async (url) => {
      const e = window.engine;
      await e.loadUrlToDeck("A", url);
      e.setCrossfade(0);
      e.play("A");
      const an = e.ctx.createAnalyser();
      e.master.connect(an);
      const buf = new Float32Array(an.fftSize);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) {
          sum += v * v;
          n++;
        }
      }
      e.master.disconnect(an);
      e.deckA.stop();
      return 10 * Math.log10(sum / n);
    }, `${MEDIA}/${name}.mp3`);

  await expect(page.getByRole("switch", { name: /Volume match/ })).toHaveAttribute("aria-checked", "true");
  const matched = (await level("loud")) - (await level("quiet"));
  expect(Math.abs(matched)).toBeLessThan(1.5);

  await page.getByRole("switch", { name: /Volume match/ }).click();
  await expect(page.getByRole("switch", { name: /Volume match/ })).toHaveAttribute("aria-checked", "false");
  const raw = (await level("loud")) - (await level("quiet"));
  expect(raw).toBeGreaterThan(3.5); // the 5 dB difference is back
});

test("copy song data puts each track's analysis on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator(".loadbar input").fill(`${MEDIA}/party_song.mp3`);
  await page.locator(".loadbar button").click();
  await expect(page.locator(".tracks li", { hasText: "party_song" })).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: /Copy song data/ }).click();
  await expect(page.getByRole("button", { name: /Copied 1 song/ })).toBeVisible();
  const data = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ title: "party_song", camelot: "8A", duration: 200 });
  expect(data[0].bigParts.length).toBeGreaterThan(0);
  expect(data[0].loudness).toHaveLength(200);
  expect(data[0].partyMixOut).toBeGreaterThan(110); // over the end of the 90-130 s chorus
  expect(data[0].partyMixOut).toBeLessThan(130);
  expect(typeof data[0].lufs).toBe("number");
});

test("Mix now starts the next song early, and the DJ can search by name", async ({ page }) => {
  await page.goto("/");
  // Search results (YouTube isn't reachable offline: answer with local test songs).
  await page.route("**/api/search?**", (route) =>
    route.fulfill({
      json: {
        results: [
          { title: "G_major", url: `${MEDIA}/G_major.mp3`, channel: "Test", duration: 24 },
          { title: "A_minor", url: `${MEDIA}/A_minor.mp3`, channel: "Test", duration: 24 },
        ],
      },
    })
  );
  await page.getByLabel("Search a song or paste a link").fill("major and minor");
  await page.getByRole("button", { name: "Search" }).click();
  for (const name of ["G_major", "A_minor"]) {
    const result = page.locator(".results li", { hasText: name });
    await result.getByRole("button", { name: /Add/ }).click();
    await expect(result.getByRole("button", { name: "Added ✓" })).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.locator(".tracks li")).toHaveCount(2);

  await page.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  const status = page.locator(".set-status");
  await expect(status).toContainText("Live · song 1 of 2", { timeout: 30_000 });
  const now = page.getByRole("region", { name: "Now playing" });
  await expect(now).toContainText(/Mixing into .* in \d+:\d\d/, { timeout: 10_000 });

  // 24 s songs with a 16 s blend would mix at ~8 s; Mix now starts it right away.
  await now.getByRole("button", { name: /Mix now/ }).click();
  await expect(status).toContainText("Mixing", { timeout: 3_000 });
  const pos = await page.evaluate(() => {
    const e = window.engine;
    return e.deck(e.auto.front).position();
  });
  expect(pos).toBeLessThan(7);
  await page.locator(".topbar").getByRole("button", { name: /Stop/ }).click();
});
