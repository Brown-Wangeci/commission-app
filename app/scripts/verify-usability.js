// Browser checks for the usability pass (run against a seeded local app): show/hide, live password rules, one primary button on the review screen, collapsed sections opening from a link or address, and the sticky commission summary. Usage, from app/: node scripts/verify-usability.js
const { chromium } = require("@playwright/test");
const APP = "http://localhost:3000";

async function login(page, email, password) {
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch();
  const out = {};

  // Sign-in with the seeded password still works, and show/hide toggles the type.
  let ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  let page = await ctx.newPage();
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Password", { exact: true }).fill("ledgerfield-demo");
  const t0 = await page.locator("#password").getAttribute("type");
  await page.getByRole("button", { name: "Show password" }).click();
  const t1 = await page.locator("#password").getAttribute("type");
  await page.getByRole("button", { name: "Hide password" }).click();
  const t2 = await page.locator("#password").getAttribute("type");
  out.toggleTypes = [t0, t1, t2];
  await page.getByLabel("Email").fill("reviewer@ledgerfield.test");
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  out.seededSignInLandedOn = new URL(page.url()).pathname;

  // Signup: weak password blocked locally, live rules update, mismatch blocks.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${APP}/signup`, { waitUntil: "networkidle" });
  await anon.getByLabel("Your full name").fill("Rule Check");
  await anon.getByLabel("Email").fill("rule.check@example.test");
  await anon.getByLabel("Password", { exact: true }).fill("password");
  out.rulesMetForWeak = await anon.locator(".rules li.met").count();
  await anon.getByLabel("Password", { exact: true }).fill("Fake-Value-123");
  out.rulesMetForStrong = await anon.locator(".rules li.met").count();
  await anon.getByLabel("Confirm password", { exact: true }).fill("Fake-Value-124");
  out.mismatchText = (await anon.locator("[role=status]").first().textContent())?.trim();

  // Review screen: one primary button; a link to the map opens the collapsed section.
  page = await ctx.newPage();
  await page.goto(`${APP}/admin/review`, { waitUntil: "networkidle" });
  const href = await page.locator('a[href^="/admin/review/"]').first().getAttribute("href");
  await page.goto(`${APP}${href}`, { waitUntil: "networkidle" });
  out.primaryButtonsOnReview = await page.locator("main .btn.primary").count();
  out.detailsClosedAtStart = await page.locator("details.disclosure:not([open])").count();
  const mapLink = page.locator(".callout a[href=\"#location\"]").first();
  if (await mapLink.count()) {
    await mapLink.click();
    await page.waitForTimeout(300);
    out.mapOpenedByLink = await page.locator("details#location").evaluate((d) => d.open);
  } else { await page.evaluate("location.hash = \"#location\""); await page.waitForTimeout(300); out.mapOpenedByLink = (await page.locator("details#location").evaluate((d) => d.open)) + " (by address, no callout link on this case)"; }
  await page.goto(`${APP}${href}#audit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  out.auditOpenedByAddress = await page.locator("details#audit").evaluate((d) => d.open);
  const decisionTop = await page.locator("#decide").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  out.decisionPanelTopPx = Math.round(decisionTop);
  await page.getByRole("button", { name: /Approve/ }).first().click();
  out.afterApproveClickPrimaryCount = await page.locator("main .btn.primary").count();
  out.afterApproveClickShowsForm = await page.locator("#reason").count();

  // Post a job: the summary stays in view after scrolling to the bottom.
  const cctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const client = await cctx.newPage();
  await login(client, "client2@ledgerfield.test", "ledgerfield-demo");
  await client.goto(`${APP}/client/jobs/new`, { waitUntil: "networkidle" });
  await client.getByLabel("Value of one approved submission").fill("3000");
  await client.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await client.waitForTimeout(200);
  const box = await client.locator(".post-summary").boundingBox();
  out.summaryVisibleAfterScroll = box && box.y >= 0 && box.y < 900;
  out.summaryText = (await client.locator(".post-summary").innerText()).replace(/\s+/g, " ").slice(0, 200);

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
