import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";

/*
 * Tickmark end-to-end checks. Every test starts in a fresh browser context,
 * so it gets its own newly seeded workspace (history + inbox).
 * Tests that send inbox invoices through the real AI pipeline only run with
 * RUN_LIVE_E2E=1.
 */
const root = path.resolve(process.cwd(), "../..");
const shots = path.join(root, "docs/screenshots");
const LIVE = process.env.RUN_LIVE_E2E === "1";
const DECISION_TIMEOUT = 300_000;
const STEPS = [
  "Received",
  "Read the document",
  "Extract the fields",
  "Supplier is approved",
  "Purchase order",
  "Lines match the order",
  "Totals add up",
  "Not a duplicate",
  "Within PO budget",
  "Explanation",
  "Decision",
];

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, "uncaught errors in the page").toEqual([]);
});

function live() {
  test.skip(!LIVE, "Set RUN_LIVE_E2E=1 to run real model calls");
  test.setTimeout(420_000);
}

async function capture(page: Page, name: string) {
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

async function accessibility(page: Page, name: string) {
  // Settle entrance animations so contrast is measured on final colours.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "docs", `axe-${name}.json`),
    JSON.stringify(result.violations, null, 2),
  );
  expect(
    result.violations,
    JSON.stringify(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ),
  ).toEqual([]);
}

async function openOverview(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.locator(".tm-kpi").first()).toBeVisible();
}

/** Checks one email from the overview inbox and lands on its invoice. */
async function checkInbox(page: Page, subject: string) {
  await openOverview(page);
  await page.getByRole("button", { name: `Check invoice: ${subject}`, exact: true }).click();
  await expect(page).toHaveURL(/\/invoices\/[^/]+$/);
}

async function verdict(page: Page, title: string) {
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({
    timeout: DECISION_TIMEOUT,
  });
}

test("overview renders the seeded history", async ({ page }) => {
  await openOverview(page);
  await expect(page).toHaveTitle("Overview · Tickmark");
  await expect(page.locator(".tm-kpi", { hasText: "Invoices processed" })).toContainText("26");
  await expect(page.locator(".tm-kpi", { hasText: "Approved automatically" })).toContainText("69%");
  await expect(page.locator(".tm-kpi", { hasText: "Needs your review" })).toContainText("2");
  await expect(page.getByRole("link", { name: /^Invoices\s*,\s*2 need review/ })).toBeVisible();

  const chart = page.getByRole("group", { name: "Invoices per week by outcome" });
  await expect(chart.getByRole("button")).toHaveCount(6);
  await chart.getByRole("button").nth(4).hover();
  await expect(page.locator(".tm-tip")).toBeVisible();
  await chart.getByRole("button").nth(3).focus();
  await expect(page.locator(".tm-tip")).toHaveCount(1);
  await page.getByRole("button", { name: "Show table", exact: true }).click();
  await expect(page.getByRole("table", { name: "Outcomes by week" })).toBeVisible();
  await page.getByRole("button", { name: "Show chart", exact: true }).click();
  await expect(chart).toBeVisible();

  // Every first reason is listed (the card scrolls), not just the top few.
  const reasons = page.getByRole("list", { name: "Reasons, most frequent first" });
  await expect(reasons.locator("li")).toHaveCount(7);
  await expect(reasons).toContainText("No PO on the invoice");
  await expect(reasons).toContainText("Duplicate invoice");
  await expect(page.getByRole("table", { name: "Latest decisions" })).toContainText("ALD-1201");

  // Needs action: reviews, holds, and blocked invoices a person can still act on.
  const action = page.getByRole("list", { name: /Invoices that need action/ });
  await expect(action).toContainText("LP-5538");
  await expect(action).toContainText("CF-7790");
  await expect(action).toContainText("On hold");
  await expect(action).toContainText("ALD-1159");
  await expect(action).toContainText("HS-0412");

  await expect(page.getByRole("button", { name: /^Check invoice: / })).toHaveCount(6);
  await expect(page.getByRole("button", { name: /^Save document: / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Check all 6", exact: true })).toBeVisible();
  await capture(page, "tickmark-overview");
});

test("clean inbox invoice is approved with every step shown", async ({ page }) => {
  live();
  await checkInbox(page, "Invoice CF-7815 · Portland LTL, 2 shipments");
  await expect
    .soft(page.getByRole("progressbar", { name: "Checks completed" }))
    .toBeVisible();
  await verdict(page, "Approved");
  const steps = page.locator(".tm-steps .tm-step");
  await expect(steps).toHaveCount(STEPS.length);
  for (const [index, label] of STEPS.entries())
    await expect(steps.nth(index).locator(".tm-step-t")).toHaveText(label);
  // Received through Decision all pass; the explanation is informational.
  await expect(page.locator(".tm-steps .tm-step > .tm-step-ic.s-passed")).toHaveCount(10);
  await expect(page.locator(".tm-verdict")).toContainText("PO-1120");
  await expect(page.getByRole("link", { name: "View purchase order" })).toBeVisible();

  const cite = page.locator(".tm-verdict .tm-cite").first();
  await cite.click();
  await expect(cite).toHaveClass(/is-on/);

  await page.getByRole("button", { name: /Supplier is approved/ }).click();
  await expect(page.getByRole("list", { name: "Individual checks" }).first()).toBeVisible();
  await capture(page, "tickmark-clean-approved");
});

test("duplicate inbox invoice is blocked and opens the original", async ({ page }) => {
  live();
  await checkInbox(page, "Resending invoice ALD-1201");
  await verdict(page, "Blocked");
  await expect(page.locator(".tm-verdict")).toContainText("Nothing new was reserved");
  await capture(page, "tickmark-duplicate-blocked");
  const duplicateUrl = page.url();
  await page.getByRole("link", { name: "Open the original", exact: true }).click();
  await expect(page).not.toHaveURL(duplicateUrl);
  await expect(page.getByRole("heading", { level: 1, name: "ALD-1201" })).toBeVisible();
  await verdict(page, "Approved");
});

test("over-budget invoice goes to procurement and waits on hold", async ({ page }) => {
  live();
  await checkInbox(page, "Invoice ALD-1450 · workspace essentials");
  await verdict(page, "Needs review");
  await expect(page.locator(".tm-verdict")).toContainText("PO-1042");
  await page.getByRole("button", { name: "Ask procurement", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Ask procurement" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("To", { exact: true })).toHaveValue("Procurement");
  await expect(panel.getByLabel("Message · drafted from the checks")).not.toHaveValue("");
  await panel.getByRole("button", { name: "Mark as sent", exact: true }).click();
  await expect(panel).toBeHidden();
  await verdict(page, "On hold");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Sent to procurement · on hold", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download decision record" })).toBeVisible();
  await capture(page, "tickmark-on-hold");

  // The reply arrived: clear the hold and run every check again.
  await page.getByRole("button", { name: "Reply received · check again", exact: true }).click();
  await verdict(page, "Needs review");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(
    page.getByText("Reply received · checking again", { exact: true }),
  ).toBeVisible();
});

test("missing PO is resolved by AI from a saved company document", async ({ page }) => {
  live();
  await checkInbox(page, "Meridian Creative · October design hours");
  await verdict(page, "Needs review");
  await expect(page.getByRole("button", { name: "Choose the order", exact: true })).toBeVisible();
  const invoiceUrl = page.url();

  await openOverview(page);
  await page
    .getByRole("button", { name: "Save document: Re: MER-2081 · project assignment", exact: true })
    .click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.goto(invoiceUrl);
  await verdict(page, "Needs review");
  await page.getByRole("button", { name: "Choose the order", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Choose the purchase order" });
  await expect(panel.getByRole("radio")).toHaveCount(2);
  await capture(page, "tickmark-choose-order");
  await panel.getByRole("button", { name: "Ask AI to check company documents" }).click();
  await verdict(page, "Approved");
  await expect(page.locator(".tm-verdict")).toContainText("PO-1088");
  await capture(page, "tickmark-ai-match");
});

test("scanned invoice with conflicting totals is rejected", async ({ page }) => {
  live();
  await checkInbox(page, "Scanned invoice FW-3099");
  await verdict(page, "Needs review");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Reject invoice" });
  await panel.getByRole("radio", { name: "Amounts can’t be reconciled" }).check();
  await panel.getByRole("button", { name: "Reject invoice", exact: true }).click();
  await expect(panel).toBeHidden();
  await verdict(page, "Rejected");
  await capture(page, "tickmark-rejected");

  // Rejected invoices have their own filter, apart from Blocked.
  await page.goto("/invoices");
  await page.getByRole("button", { name: /^Rejected/ }).click();
  await expect(page.getByRole("table", { name: "Rejected invoices" })).toContainText("FW-3099");
});

test("suppliers, purchase orders and policy pages render", async ({ page }) => {
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { level: 1, name: "Suppliers" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Alder Office Supply/ })).toContainText("Approved");
  await expect(page.getByRole("row", { name: /Harbor Services/ })).toContainText("Inactive");
  await capture(page, "tickmark-suppliers");

  await page.goto("/purchase-orders");
  await expect(page.getByRole("heading", { level: 1, name: "Purchase orders" })).toBeVisible();
  await expect(page.getByRole("row", { name: /PO-1042/ })).toContainText("$4,000.00");
  await expect(page.getByRole("row", { name: /PO-0999/ })).toContainText("Closed");
  await capture(page, "tickmark-purchase-orders");

  await page.goto("/policy");
  await expect(page.getByRole("heading", { level: 1, name: "Policy AP-2026.1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Company documents" })).toBeVisible();
  await expect(page.getByText("Never guessed", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Prices are compared net of tax; the PO budget counts the full amount including tax.",
    ),
  ).toBeVisible();
  await capture(page, "tickmark-policy");
});

test("overview and an invoice fit a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOverview(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await capture(page, "tickmark-overview-390");
  await page.getByRole("link", { name: "LP-5538" }).first().click();
  await verdict(page, "Needs review");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await capture(page, "tickmark-invoice-390");
});

test("overview and invoice detail pass an accessibility scan", async ({ page }) => {
  await openOverview(page);
  await accessibility(page, "tickmark-overview");

  await page.getByRole("link", { name: "LP-5538" }).first().click();
  await verdict(page, "Needs review");
  await accessibility(page, "tickmark-invoice");

  // Panels are keyboard dialogs: open with Enter, close with Escape, focus returns.
  const ask = page.getByRole("button", { name: "Ask procurement", exact: true });
  await ask.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Ask procurement" })).toBeVisible();
  await accessibility(page, "tickmark-panel");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(ask).toBeFocused();
});
