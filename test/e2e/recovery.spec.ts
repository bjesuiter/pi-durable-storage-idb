import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const fixture = "/test/browser/";

test("reloads and resumes a persisted running task exactly once", async ({ page }) => {
  const name = `reload-${crypto.randomUUID()}`;
  await page.goto(fixture);
  await page.waitForFunction(() => window.durableTest !== undefined);
  await page.evaluate((name) => window.durableTest.seed(name), name);
  await page.reload();
  await page.waitForFunction(() => window.durableTest !== undefined);
  const result = await page.evaluate((name) => window.durableTest.resume(name), name);
  expect(result).toEqual({ outcome: { status: "completed", result: 42 }, counter: { count: 42 }, entries: ["test.before", "test.resumed"] });
  await page.reload();
  await page.waitForFunction(() => window.durableTest !== undefined);
  expect(await page.evaluate((name) => window.durableTest.resume(name), name)).toEqual(result);
});

test("recovers committed state after closing and replacing the page", async ({ page, context }) => {
  const name = `new-page-${crypto.randomUUID()}`;
  await page.goto(fixture);
  await page.waitForFunction(() => window.durableTest !== undefined);
  await page.evaluate((name) => window.durableTest.seed(name), name);
  await page.close();
  const replacement = await context.newPage();
  await replacement.goto(fixture);
  await replacement.waitForFunction(() => window.durableTest !== undefined);
  const result = await replacement.evaluate((name) => window.durableTest.resume(name), name);
  expect(result.counter).toEqual({ count: 42 });
  expect(result.entries).toEqual(["test.before", "test.resumed"]);
});

test("discards an unfinished transaction after a renderer crash", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "CDP renderer crash injection is Chromium-only");
  const name = `crash-${crypto.randomUUID()}`;
  await page.goto(fixture);
  await page.waitForFunction(() => window.durableTest !== undefined);
  await page.evaluate((name) => window.durableTest.seed(name), name);
  await page.evaluate(() => window.durableTest.interrupt());
  await page.waitForFunction(() => window.durableTest.isPending());
  const client = await context.newCDPSession(page);
  const crashed = page.waitForEvent("crash");
  void client.send("Page.crash").catch(() => undefined);
  await crashed;
  await page.close();
  const replacement = await context.newPage();
  await replacement.goto(fixture);
  await replacement.waitForFunction(() => window.durableTest !== undefined);
  const result = await replacement.evaluate((name) => window.durableTest.resume(name), name);
  expect(result.counter).toEqual({ count: 42 });
  expect(result.entries).toEqual(["test.before", "test.resumed"]);
});

test("resumes after restarting a browser with its persistent profile", async ({ browserName, baseURL }) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-idb-"));
  const browser = { chromium, firefox, webkit }[browserName];
  let context = await browser.launchPersistentContext(directory, { headless: true });
  const name = `restart-${crypto.randomUUID()}`;
  try {
    let page = await context.newPage();
    await page.goto(`${baseURL}${fixture}`);
    await page.waitForFunction(() => window.durableTest !== undefined);
    await page.evaluate((name) => window.durableTest.seed(name), name);
    await context.close();
    context = await browser.launchPersistentContext(directory, { headless: true });
    page = await context.newPage();
    await page.goto(`${baseURL}${fixture}`);
    await page.waitForFunction(() => window.durableTest !== undefined);
    const result = await page.evaluate((name) => window.durableTest.resume(name), name);
    expect(result.counter).toEqual({ count: 42 });
    expect(result.entries).toEqual(["test.before", "test.resumed"]);
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
