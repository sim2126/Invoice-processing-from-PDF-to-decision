import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.resolve(process.cwd(), "../..");
const shots = path.join(root, "docs/screenshots");
async function capture(page: Page, name: string) {
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({
    path: path.join(shots, name + ".png"),
    fullPage: true,
  });
}
async function accessibility(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await fs.writeFile(
    path.join(root, "docs", `axe-${name}.json`),
    JSON.stringify(result.violations, null, 2),
  );
  expect
    .soft(
      result.violations,
      JSON.stringify(
        result.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ),
    )
    .toEqual([]);
}
async function launch(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Run ${name}`, exact: true }).click();
  await expect(page).toHaveURL(/\/invoices\//);
}
async function outcome(page: Page, name: string) {
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(
    page.getByText("Saved to this workspace", { exact: true }),
  ).toBeVisible();
}

test("queue, file validation, keyboard, fresh session and narrow screen", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Invoice queue." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Upload invoice", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Choose invoice PDF").setInputFiles({
    name: "empty.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("alert")).toContainText("non-empty PDF");
  await accessibility(page, "upload-dialog");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload invoice", exact: true }),
  ).toBeFocused();
  await capture(page, "queue-empty-1440");
  await accessibility(page, "queue");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByRole("button", { name: "Upload invoice", exact: true })
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await page.setViewportSize({ width: 1280, height: 800 });
  await capture(page, "queue-1280");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "queue-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Start fresh demo", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start fresh demo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your next clear decision starts here" }),
  ).toBeVisible();
});

test("live PDFs: happy path, four exceptions, correction loop, evidence, SSE, reload and mobile", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_LIVE_E2E !== "1",
    "Explicitly enable real model calls with RUN_LIVE_E2E=1",
  );
  test.setTimeout(720000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/invoices/*/events*", (route) => route.abort());
  await launch(page, "A clean match");
  await expect(page.getByText(/status polling is active/)).toBeVisible();
  await outcome(page, "Approved");
  await page.unroute("**/api/invoices/*/events*");
  const cleanUrl = page.url();
  await capture(page, "approved-1440");
  await page.setViewportSize({ width: 1280, height: 800 });
  await capture(page, "approved-1280");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Fields", exact: true }).click();
  await page
    .getByRole("button", { name: /Found in document/ })
    .first()
    .click();
  await expect(
    page.getByText(/Source highlighted|Cited page; no reliable highlight/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fit document", exact: true }).click();
  await page.reload();
  await outcome(page, "Approved");
  await accessibility(page, "approved");
  await launch(page, "Same invoice, new PDF");
  await outcome(page, "Blocked");
  await expect(
    page.getByRole("link", { name: "View the original invoice" }),
  ).toHaveAttribute("href", new URL(cleanUrl).pathname);
  await capture(page, "duplicate-1440");
  await launch(page, "A PO at its limit");
  await outcome(page, "Review required");
  await expect(page.getByText(/Only \$4,000.00 remains/).first()).toBeVisible();
  await capture(page, "review-1440");
  await accessibility(page, "review");
  await launch(page, "Two possible orders");
  await outcome(page, "Review required");
  await page
    .getByRole("button", { name: "Review & resolve", exact: true })
    .click();
  await page
    .getByLabel("Confirm purchase order")
    .selectOption({ label: "PO-1088 · Brand studio · September" });
  await page
    .getByLabel("Reason for this review")
    .fill(
      "Confirmed with the brand studio owner against the September design engagement.",
    );
  await page
    .getByRole("button", { name: "Run checks again", exact: true })
    .click();
  await outcome(page, "Approved");
  await expect(page.getByText(/Resolved through review/)).toBeVisible();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    page.getByText("Review changes recorded", { exact: true }),
  ).toBeVisible();
  await capture(page, "resolved-history");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /^Checks/ }).click();
  await capture(page, "workspace-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Source document", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: /Invoice source, page 1/ }),
  ).toBeVisible();
  await capture(page, "source-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await launch(page, "The numbers disagree");
  await outcome(page, "Review required");
  await expect(
    page.getByText(/Calculated \$900.00 \/ stated \$990.00/).first(),
  ).toBeVisible();
  await capture(page, "scan-review");
  await page.goto("/");
  await expect(page.getByText("ALD-1201", { exact: true })).toHaveCount(2);
  await capture(page, "queue-populated-1440");
  await page.getByRole("button", { name: /^Needs review/ }).click();
  await expect(
    page.getByRole("link", { name: /FW-3099/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /^All invoices/ }).click();
  await page.getByRole("textbox", { name: "Search invoices" }).fill("MER-2081");
  await expect(
    page.getByText("1 of 5 invoices", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search invoices" }).fill("");
  await page
    .context()
    .storageState({ path: path.join(root, ".local", "browser-session.json") });
  expect(errors).toEqual([]);
});
