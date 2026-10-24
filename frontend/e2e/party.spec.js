import { expect, test as base } from "@playwright/test";
import { API_PORT, MEDIA_PORT } from "../playwright.config.js";

const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

// `device(opts)` opens a page in its own browser context (separate storage, like a separate
// phone or computer); all of them close when the test ends, so no stale DJ keeps syncing.
const test = base.extend({
  device: async ({ browser }, provide) => {
    const made = [];
    await provide(async (opts) => {
      const ctx = await browser.newContext(opts);
      made.push(ctx);
      return ctx.newPage();
    });
    for (const ctx of made) await ctx.close();
  },
});

// YouTube search isn't reachable offline: answer it with the local test songs.
async function fakeSearch(phone) {
  await phone.route("**/api/search?**", (route) =>
    route.fulfill({
      json: {
        results: [
          { title: "A_minor", url: `${MEDIA}/A_minor.mp3`, channel: "Test", duration: 24 },
          { title: "C_major", url: `${MEDIA}/C_major.mp3`, channel: "Test", duration: 24 },
        ],
      },
    })
  );
}

async function join(phone, name) {
  await phone.goto("/guest");
  await phone.getByLabel("What's your name?").fill(name);
  await phone.getByRole("button", { name: "Join" }).click();
}

test("friends add songs from their phones and votes reorder the queue", async ({ device }) => {
  test.setTimeout(180_000);
  // The DJ's computer and a friend's phone: separate contexts, like separate devices.
  const host = await device();
  const phone = await device({ viewport: { width: 390, height: 844 } });
  const errors = [];
  for (const p of [host, phone]) p.on("pageerror", (e) => errors.push(e.message));

  await host.goto("/");
  await host.locator(".loadbar input").fill(`${MEDIA}/G_major.mp3`);
  await host.locator(".loadbar button").click();
  const rows = host.locator(".tracks li");
  await expect(rows).toHaveCount(1, { timeout: 60_000 });
  await host.getByRole("button", { name: "Start party session" }).click();

  // The DJ's panel checks the network and waits for a phone.
  const status = host.locator(".party-status");
  await expect(status).toContainText("Music server reachable on your network", { timeout: 10_000 });
  await expect(status).toContainText("App reachable on your network");
  await expect(status).toContainText("No phones connected yet");

  await fakeSearch(phone);
  await join(phone, "Ana");
  await expect(phone.locator(".g-conn")).toContainText("Connected to the DJ");
  await expect(status).toContainText("1 phone connected: Ana", { timeout: 5_000 });

  // Search by name: the request is confirmed at once, then shows progress.
  await phone.getByPlaceholder("Search a song or paste a link").fill("minor");
  await phone.getByRole("button", { name: "Search" }).click();
  const result = phone.locator(".g-results li", { hasText: "A_minor" });
  await result.getByRole("button", { name: /Add/ }).click();
  await expect(result.getByRole("button", { name: "Requested ✓" })).toBeVisible({ timeout: 5_000 });
  await expect(phone.locator(".g-song.pending", { hasText: "A_minor" })).toBeVisible();

  // ...or paste a link.
  await phone.getByPlaceholder("Search a song or paste a link").fill(`${MEDIA}/C_major.mp3`);
  await phone.getByRole("button", { name: "Search" }).click();
  const pasted = phone.locator(".g-results li"); // a pasted link replaces the search results
  await expect(pasted).toHaveCount(1);
  await expect(pasted.getByRole("button", { name: "Requested ✓" })).toBeVisible({ timeout: 5_000 });

  // Both land in the DJ's playlist, credited to Ana, and leave "On the way".
  await expect(rows).toHaveCount(3, { timeout: 60_000 });
  await expect(host.locator(".tracks li", { hasText: "A_minor" })).toContainText("Ana");
  await expect(host.locator(".tracks li", { hasText: "C_major" })).toContainText("Ana");
  await expect(phone.locator(".g-song.pending")).toHaveCount(0, { timeout: 5_000 });

  // The phone sees the queue; an upvote sends C_major to the top.
  const song = (title) => phone.locator(".g-song", { hasText: title });
  await expect(phone.locator(".g-song")).toHaveCount(3, { timeout: 10_000 });
  await phone.getByRole("button", { name: "Upvote C_major" }).click();
  await expect(song("C_major").locator(".g-score")).toHaveText("1");
  await expect(rows.nth(0)).toContainText("C_major", { timeout: 10_000 });
  await expect(rows.nth(0).locator(".votes")).toHaveText("▲ 1");

  // Three downvotes drop a song.
  const queue = await (await phone.request.get(`${API}/api/party/queue`)).json();
  const gId = queue.upcoming.find((t) => t.title === "G_major").id;
  for (const voter of ["x1", "x2", "x3"])
    await phone.request.post(`${API}/api/party/vote`, { data: { trackId: gId, voter, value: -1 } });
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await expect(host.locator(".tracks li", { hasText: "G_major" })).toHaveCount(0);

  // Start the set: the phone shows what's playing and what's next.
  await host.locator(".topbar").getByRole("button", { name: /Start set/ }).click();
  const nowCard = phone.getByRole("region", { name: "Now playing" });
  await expect(nowCard).toContainText("NOW PLAYING", { timeout: 15_000 });
  await expect(nowCard).toContainText("C_major");
  await expect(nowCard).toContainText("UP NEXT");
  await expect(nowCard).toContainText(/in \d+:\d\d/); // countdown to the next song
  const fill = nowCard.locator(".g-progress-fill");
  const w1 = await fill.evaluate((el) => parseFloat(el.style.width));
  await phone.waitForTimeout(2000);
  expect(await fill.evaluate((el) => parseFloat(el.style.width))).toBeGreaterThan(w1); // it moves

  await host.locator(".topbar").getByRole("button", { name: /Stop/ }).click();
  expect(errors).toEqual([]);
});

test("phones get clear feedback when something's wrong", async ({ device }) => {
  test.setTimeout(120_000);
  const host = await device();
  const phone = await device({ viewport: { width: 390, height: 844 } });
  await host.goto("/");
  await host.getByRole("button", { name: "Start party session" }).click();
  await join(phone, "Ben");
  const bar = phone.locator(".g-conn");
  await expect(bar).toContainText("Connected to the DJ");

  // A link that can't be added: the requester sees why.
  await phone.getByPlaceholder("Search a song or paste a link").fill(`${MEDIA}/missing.mp3`);
  await phone.getByRole("button", { name: "Search" }).click();
  await expect(phone.locator(".g-song.pending.failed")).toContainText("couldn't add", {
    timeout: 30_000,
  });

  // The connection drops mid-party, then comes back.
  await phone.route("**/api/party/queue?**", (route) => route.abort());
  await expect(bar).toContainText("Lost connection to the DJ", { timeout: 10_000 });
  await expect(bar).toContainText("same Wi-Fi");
  await phone.unroute("**/api/party/queue?**");
  await expect(bar).toContainText("Connected to the DJ", { timeout: 10_000 });

  // A phone that never reaches the music server (e.g. firewall on the DJ's computer).
  const blocked = await device();
  await blocked.route("**/api/party/**", (route) => route.abort());
  await join(blocked, "Cy");
  await expect(blocked.locator(".g-conn")).toContainText("Can't reach the DJ's music server", {
    timeout: 15_000,
  });
  await expect(blocked.locator(".g-conn")).toContainText("Windows Firewall");

  // The DJ turns the party session off: phones are told (after the 10 s heartbeat timeout).
  await host.getByRole("region", { name: "Party session" }).getByRole("button", { name: "End" }).click();
  await expect(bar).toContainText("party session is off", { timeout: 20_000 });
});
