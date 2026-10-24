import { expect, test } from "@playwright/test";
import { API_PORT, MEDIA_PORT } from "../playwright.config.js";

const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

test("friends add songs from their phones and votes reorder the queue", async ({ browser }) => {
  test.setTimeout(180_000);
  // The DJ's computer and a friend's phone: separate contexts, like separate devices.
  const host = await (await browser.newContext()).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  for (const p of [host, phone]) p.on("pageerror", (e) => errors.push(e.message));

  await host.goto("/");
  await host.locator(".loadbar input").fill(`${MEDIA}/G_major.mp3`);
  await host.locator(".loadbar button").click();
  const rows = host.locator(".tracks li");
  await expect(rows).toHaveCount(1, { timeout: 60_000 });
  await host.getByRole("button", { name: /Party session: OFF/ }).click();
  await expect(host.getByRole("button", { name: /Party session: ON/ })).toBeVisible();

  // YouTube search isn't reachable offline: answer it with the local test songs.
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
  await phone.goto("/guest");
  await phone.getByLabel("What's your name?").fill("Ana");
  await phone.getByRole("button", { name: "Join" }).click();

  // Search by name and add.
  await phone.getByPlaceholder("Search a song or paste a link").fill("minor");
  await phone.getByRole("button", { name: "Search" }).click();
  const result = phone.locator(".g-results li", { hasText: "A_minor" });
  await result.getByRole("button", { name: /Add/ }).click();
  await expect(result.getByRole("button", { name: "Added ✓" })).toBeVisible({ timeout: 60_000 });

  // ...or paste a link.
  await phone.getByPlaceholder("Search a song or paste a link").fill(`${MEDIA}/C_major.mp3`);
  await phone.getByRole("button", { name: "Search" }).click();
  const pasted = phone.locator(".g-results li"); // a pasted link replaces the search results
  await expect(pasted).toHaveCount(1);
  await expect(pasted.getByRole("button", { name: "Added ✓" })).toBeVisible({ timeout: 60_000 });

  // Both land in the DJ's playlist, credited to Ana.
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(host.locator(".tracks li", { hasText: "A_minor" })).toContainText("Ana");
  await expect(host.locator(".tracks li", { hasText: "C_major" })).toContainText("Ana");

  // The phone sees the queue; an upvote sends C_major to the top.
  const song = (title) => phone.locator(".g-song", { hasText: title });
  await expect(phone.locator(".g-song")).toHaveCount(3, { timeout: 10_000 });
  await phone.getByRole("button", { name: "Upvote C_major" }).click();
  await expect(song("C_major").locator(".g-score")).toHaveText("1");
  await expect(rows.nth(0)).toContainText("C_major", { timeout: 10_000 });
  await expect(rows.nth(0).locator(".chip.votes")).toHaveText("▲ 1");

  // Three downvotes drop a song.
  const queue = await (await phone.request.get(`${API}/api/party/queue`)).json();
  const gId = queue.upcoming.find((t) => t.title === "G_major").id;
  for (const voter of ["x1", "x2", "x3"])
    await phone.request.post(`${API}/api/party/vote`, { data: { trackId: gId, voter, value: -1 } });
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await expect(host.locator(".tracks li", { hasText: "G_major" })).toHaveCount(0);

  // Start the set: the phone shows what's playing and what's next.
  await host.getByRole("button", { name: /Start Set/ }).click();
  await expect(phone.locator(".g-song.featured").first()).toContainText("NOW PLAYING", {
    timeout: 15_000,
  });
  await expect(phone.locator(".g-song.featured").first()).toContainText("C_major");
  await expect(phone.locator(".g-song.featured").nth(1)).toContainText("UP NEXT");

  await host.getByRole("button", { name: /Stop/ }).click();
  expect(errors).toEqual([]);
});
