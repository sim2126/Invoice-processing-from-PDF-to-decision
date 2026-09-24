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
  await page.goto("/demo");
  if (name === "A clean match") {
    await page
      .getByRole("button", { name: `Preview ${name} PDF`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Run this scenario", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: `Run ${name}`, exact: true })
      .click();
  }
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
    page.getByRole("heading", { name: "Invoices", exact: true }),
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
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await page.getByRole("link", { name: /^To-do/ }).click();
  await expect(page).toHaveURL(/\/attention$/);
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Invoices", exact: true }).click();
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
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(
    page.getByRole("heading", { name: "Documents", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Invoices", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Invoices", exact: true }),
  ).toBeVisible();
  await page.goto("/settings");
  await page
    .getByRole("button", { name: "Start a fresh workspace", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start fresh workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your next clear decision starts here" }),
  ).toBeVisible();
});

test("built-in samples: previews, downloads, retry, keyboard and mobile without submission", async ({
  page,
}) => {
  await page.goto("/demo");
  const previews = page.getByRole("button", { name: /^Preview .+ PDF$/ });
  await expect(previews).toHaveCount(5);
  await capture(page, "demo-library-1440");
  await accessibility(page, "demo-library");
  for (const preview of await previews.all()) {
    await preview.click();
    const original = page.getByRole("img", {
      name: /^Original sample invoice:/,
    });
    await expect(original).toBeVisible();
    await expect
      .poll(() =>
        original.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(600);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(preview).toBeFocused();
  }
  await page.route("**/api/scenarios/clean/preview?*", (route) =>
    route.fulfill({ status: 503, body: "Temporarily unavailable" }),
  );
  await previews.first().click();
  await expect(page.getByRole("alert")).toContainText("preview could not load");
  await page.unroute("**/api/scenarios/clean/preview?*");
  await page
    .getByRole("button", { name: "Retry preview", exact: true })
    .click();
  const image = page.getByRole("img", { name: /^Original sample invoice:/ });
  await expect
    .poll(() =>
      image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(600);
  await page
    .getByRole("button", { name: "Zoom in preview", exact: true })
    .click();
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fit preview", exact: true }).click();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "sample-preview-1440.png") });
  await accessibility(page, "sample-preview");
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF", exact: true }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toBe("01-clean.pdf");
  expect(
    (await fs.readFile((await pdf.path())!)).subarray(0, 5).toString(),
  ).toBe("%PDF-");
  await page.keyboard.press("Escape");
  const packDownload = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download demo pack (5 PDFs)", exact: true })
    .click();
  const pack = await packDownload;
  expect(pack.suggestedFilename()).toBe("ap-review-desk-demo.zip");
  expect(
    (await fs.readFile((await pack.path())!)).subarray(0, 2).toString(),
  ).toBe("PK");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "demo-library-mobile");
  await previews.last().click();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: /^Original sample invoice:/ })
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(600);
  await page.screenshot({
    path: path.join(shots, "sample-preview-mobile.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.goto("/");
  await expect(
    page.getByText("0 of 0 invoices", { exact: true }),
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
  await page.getByRole("link", { name: /^To-do/ }).click();
  await expect(
    page.getByRole("heading", { name: "To-do", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("3 of 5 invoices", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("MER-2081", { exact: true })).not.toBeVisible();
  await capture(page, "attention-populated-1440");
  await accessibility(page, "attention");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await capture(page, "attention-populated-mobile");
  await page.goto("/");
  await expect(
    page.getByText("5 of 5 invoices", { exact: true }),
  ).toBeVisible();
  await capture(page, "queue-populated-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .context()
    .storageState({ path: path.join(root, ".local", "browser-session.json") });
  expect(errors).toEqual([]);
});
