import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.resolve(process.cwd(), "../..");
test("company, profile, supplier directory, reference preview and team access", async ({
  page,
  browser,
}) => {
  await page.goto("/profile");
  await page.getByLabel("Full name", { exact: true }).fill("Maya Patel");
  await page.getByLabel("Email", { exact: true }).fill("maya@example.com");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved");
  await page.goto("/settings");
  await page.getByLabel("Company name", { exact: true }).fill("Juniper Studio");
  await page.getByRole("button", { name: "Save company settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings saved");
  await page.reload();
  await expect(page.getByLabel("Company name", { exact: true })).toHaveValue(
    "Juniper Studio",
  );
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/product-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByText("Coming soon", { exact: true })).toHaveCount(5);
  await page.screenshot({
    path: path.join(root, "docs/screenshots/product-connections.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("viewer");
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = page.getByLabel("Invitation for alex@example.com");
  await expect(invite).toBeVisible();
  const url = await invite.inputValue();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(url);
  await expect(
    guest.getByRole("heading", { name: "Join Juniper Studio" }),
  ).toBeVisible();
  await guest.getByLabel("Your full name").fill("Alex Rivera");
  await guest.getByRole("button", { name: "Join workspace" }).click();
  await expect(
    guest.getByRole("button", { name: "Upload invoice", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await guest.reload();
  await expect(
    guest.getByRole("heading", { name: "Your session has ended" }),
  ).toBeVisible();
  await guestContext.close();
  await page.goto("/suppliers");
  await expect(
    page.getByRole("button", { name: "Alder Office Supply", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search suppliers").fill("Alder");
  await expect(page.locator(".directory-table tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Alder Office Supply", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("PO-1042");
  await page.keyboard.press("Escape");
  await page.getByLabel("Search suppliers").fill("");
  await page.screenshot({
    path: path.join(root, "docs/screenshots/product-suppliers.png"),
    fullPage: true,
  });
  await page.goto("/documents");
  await page.getByRole("button", { name: "Add example reference" }).click();
  await expect(
    page.getByText("project-assignment.pdf", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Preview project-assignment.pdf" })
    .click();
  const image = page.getByRole("img", {
    name: "project-assignment.pdf, page 1",
  });
  await expect
    .poll(() => image.evaluate((n) => (n as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(600);
  await page.keyboard.press("Escape");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: path.join(root, "docs/screenshots/product-documents.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Archive project-assignment.pdf" })
    .click();
  await expect(
    page.getByText("project-assignment.pdf", { exact: true }),
  ).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/suppliers", "/settings", "/profile", "/documents"]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
});

test("live reference-backed AI resolves a missing PO without manually choosing it", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_LIVE_E2E !== "1",
    "Explicit live model opt-in required",
  );
  test.setTimeout(420000);
  await page.goto("/demo");
  await page
    .getByRole("button", { name: "Run Two possible orders", exact: true })
    .click();
  await expect(page.getByRole("heading", {name:"Review required",exact:true})).toBeVisible({timeout:300000});
  const invoiceUrl = page.url();
  await page.goto("/documents");
  await page.getByRole("button", { name: "Add example reference" }).click();
  await expect(page.getByText("project-assignment.pdf", { exact: true })).toBeVisible();
  await page.goto(invoiceUrl);
  await page.getByRole("button", {name:"Ask AI to review",exact:true}).click();
  await expect(
    page.getByRole("heading", { name: "Approved", exact: true }),
  ).toBeVisible({ timeout: 300000 });
  await expect(
    page.getByText("PO matched from evidence", { exact: true }),
  ).toBeVisible();
  const id = page.url().split("/").pop();
  const data = await page.evaluate(
    async (invoiceId) => (await fetch(`/api/invoices/${invoiceId}`)).json(),
    id,
  );
  expect(data.decision.assistant.status).toBe("ready");
  expect(data.decision.assistant.auto_matched).toBe(true);
  expect(data.invoice.po_reference).toBe("PO-1088");
  expect(data.invoice.revision).toBe(2);
  await page.getByText(/Sources used/).click();
  await expect(
    page.getByText("project-assignment.pdf · Page 1", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/product-ai-match.png"),
    fullPage: true,
  });
  await page.goto("/demo");
  await page.getByRole("button",{name:"Load example invoices",exact:true}).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("4 of 4 invoices",{exact:true})).toBeVisible();
});
