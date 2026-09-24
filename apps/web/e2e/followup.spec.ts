import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import type { Detail, FollowUpExample } from "../src/lib/api";

const root = path.resolve(process.cwd(), "../..");

async function examplesPage(page: Page) {
  await page.goto("/documents");
  await page
    .getByRole("button", { name: "Follow-up examples", exact: true })
    .click();
  await expect(page.locator('[data-testid^="followup-"]')).toHaveCount(5);
}

async function readApi<T>(page: Page, endpoint: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(`/api${url}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return response.json();
  }, endpoint);
}

async function screenshot(page: Page, name: string) {
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots", name),
    fullPage: true,
  });
}

test("follow-up examples preview both documents without submitting, with mobile access", async ({
  page,
}) => {
  await examplesPage(page);
  const examples = await readApi<FollowUpExample[]>(
    page,
    "/follow-up-examples",
  );
  expect(examples).toHaveLength(5);
  await screenshot(page, "followup-examples-desktop.png");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  for (const example of examples) {
    for (const kind of ["invoice", "supporting document"]) {
      await page
        .getByRole("button", {
          name: `Preview ${kind} for ${example.invoice_number}`,
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog");
      const image = dialog.getByRole("img");
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate(
            (element) => (element as HTMLImageElement).naturalWidth,
          ),
        )
        .toBeGreaterThan(600);
      await expect(dialog).toContainText(
        kind === "invoice" ? example.file : example.reference_file,
      );
      if (example.id === "brand-assignment" && kind === "supporting document") {
        await screenshot(page, "followup-supporting-pdf.png");
        expect(
          (
            await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa"])
              .analyze()
          ).violations,
        ).toEqual([]);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    }
  }
  expect(
    (await readApi<{ invoices: unknown[] }>(page, "/invoices")).invoices,
  ).toEqual([]);
  expect(await readApi<unknown[]>(page, "/documents")).toEqual([]);
  const packDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download.*10 PDFs/i }).click();
  expect((await packDownload).suggestedFilename()).toMatch(/\.zip$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "followup-examples-mobile.png");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
});

test("live five follow-ups resolve four assignments and retain the budget exception", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_LIVE_E2E !== "1",
    "Explicit live model opt-in required",
  );
  test.setTimeout(600000);
  await examplesPage(page);
  const examples = await readApi<FollowUpExample[]>(
    page,
    "/follow-up-examples",
  );
  const invoices = new Map<string, string>();
  for (const example of examples) {
    await examplesPage(page);
    await page
      .getByRole("button", {
        name: `Run invoice ${example.invoice_number}`,
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/invoices\//);
    invoices.set(example.id, page.url().split("/").pop()!);
  }
  for (const example of examples) {
    const id = invoices.get(example.id)!;
    await expect
      .poll(
        async () => (await readApi<Detail>(page, `/invoices/${id}`)).run.state,
        { timeout: 240000, intervals: [2000] },
      )
      .toBe("COMPLETED");
    const before = await readApi<Detail>(page, `/invoices/${id}`);
    expect(before.invoice.outcome).toBe("NEEDS_REVIEW");
    expect(before.decision?.assistant?.status).toBe("ready");
    expect(before.decision?.assistant?.draft_message).toBeTruthy();
    expect(before.decision?.assistant?.auto_matched).toBe(false);
  }
  await page.goto(`/invoices/${invoices.get("brand-assignment")}`);
  await page.getByText("Prepared follow-up draft", { exact: true }).click();
  await expect(
    page.getByText("Review before sharing. Nothing has been sent.", {
      exact: true,
    }),
  ).toBeVisible();
  await screenshot(page, "followup-ai-request.png");
  await examplesPage(page);
  for (const example of examples) {
    await page
      .getByRole("button", {
        name: `Add supporting document for ${example.invoice_number}`,
        exact: true,
      })
      .click();
    await expect
      .poll(async () =>
        (await readApi<{ filename: string }[]>(page, "/documents")).some(
          (doc) => doc.filename === example.reference_file,
        ),
      )
      .toBe(true);
    await expect(
      page.getByTestId(`followup-${example.id}`).getByRole("status"),
    ).toBeVisible();
  }
  for (const example of examples) {
    await page.goto(`/invoices/${invoices.get(example.id)}`);
    await page
      .getByRole("button", { name: "Ask AI to review", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readApi<Detail>(page, `/invoices/${invoices.get(example.id)}`))
            .invoice.revision,
      )
      .toBe(2);
  }
  const results = [];
  for (const example of examples) {
    const id = invoices.get(example.id)!;
    await expect
      .poll(
        async () => (await readApi<Detail>(page, `/invoices/${id}`)).run.state,
        { timeout: 240000, intervals: [2000] },
      )
      .toBe("COMPLETED");
    const after = await readApi<Detail>(page, `/invoices/${id}`);
    const expected =
      example.id === "budget-shortfall" ? "NEEDS_REVIEW" : "APPROVED";
    expect(after.invoice.outcome).toBe(expected);
    expect(after.decision?.assistant?.status).toBe("ready");
    expect(after.decision?.assistant?.auto_matched).toBe(true);
    expect(
      after.history.some(
        (decision) =>
          decision.revision === 1 && decision.outcome === "NEEDS_REVIEW",
      ),
    ).toBe(true);
    const sources = after.decision?.assistant?.sources as { title: string }[];
    expect(
      sources.some((source) => source.title === example.reference_file),
    ).toBe(true);
    if (example.id === "budget-shortfall") {
      expect(Number(after.decision?.comparison.shortfall)).toBe(500);
      expect(
        after.decision?.checks.some((check) => check.state === "review"),
      ).toBe(true);
    }
    results.push({
      invoice: example.invoice_number,
      outcome: after.invoice.outcome,
      po: after.invoice.po_reference,
      autoMatched: true,
      source: example.reference_file,
    });
  }
  await page.goto(`/invoices/${invoices.get("brand-assignment")}`);
  await expect(
    page.getByRole("heading", { name: "Approved", exact: true }),
  ).toBeVisible();
  await page.getByText(/Sources used/).click();
  await screenshot(page, "followup-ai-approved.png");
  await page.goto(`/invoices/${invoices.get("budget-shortfall")}`);
  await expect(
    page.getByText("PO matched from evidence", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review required", exact: true }),
  ).toBeVisible();
  await screenshot(page, "followup-budget-hold.png");
  await examplesPage(page);
  await screenshot(page, "followup-completed-examples.png");
  await fs.writeFile(
    path.join(root, "docs/followup-live-results.json"),
    JSON.stringify(results, null, 2),
  );
});
