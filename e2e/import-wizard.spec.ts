import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Import wizard flow:
 *   Step 1 (upload): select account → upload a 2-row CSV
 *   Step 2 (map):    map Date/Description/Amount columns → "Stage import"
 *   Step 3 (preview): see "2 new" badge → "Import 2 transactions"
 *   After commit: success toast; inbox has pending entries
 *
 * CSV uses YYYY-MM-DD dates with a single "Amount" column.
 * Negative amounts = debits.
 */

const CSV_CONTENT = `Date,Description,Amount
2026-06-01,Coffee Shop,-150.00
2026-06-02,Salary,50000.00
`;

test("import wizard: upload CSV → map → preview → commit → inbox shows entries", async ({
  page,
}) => {
  // Write CSV to a temp file
  const tmpFile = path.join(os.tmpdir(), `e2e-import-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, CSV_CONTENT, "utf-8");

  try {
    await page.goto("/import");

    // ── Step 1: Select the SBI account ──────────────────────────────────────
    // The account Select shows "Select account…" as placeholder
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "SBI" }).click();

    // Upload the file via the hidden <input type="file"> inside the label
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(tmpFile);

    // ── Step 2: Map columns ──────────────────────────────────────────────────
    // After parsing, we arrive at the "Map columns" step.
    await expect(page.getByText("Map columns")).toBeVisible({ timeout: 15_000 });

    // Map Date column → "Date" header
    // The wizard renders pairs of Selects: Date *, Description *, then optional roles.
    // Use label-adjacent combobox approach; select by label text proximity.
    const dateLabel = page.getByText("Date *");
    await dateLabel.locator("..").locator("button[role='combobox']").click();
    await page.getByRole("option", { name: "Date" }).first().click();

    // Map Description column
    const descLabel = page.getByText("Description *");
    await descLabel.locator("..").locator("button[role='combobox']").click();
    await page.getByRole("option", { name: "Description" }).first().click();

    // Map Amount (single col.)
    const amtLabel = page.getByText("Amount (single col.)");
    await amtLabel.locator("..").locator("button[role='combobox']").click();
    await page.getByRole("option", { name: "Amount" }).first().click();

    // Date format: YYYY-MM-DD
    const fmtLabel = page.getByText("Date format *");
    await fmtLabel.locator("..").locator("button[role='combobox']").click();
    await page.getByRole("option", { name: /YYYY-MM-DD/i }).click();

    // Click "Stage import"
    await page.getByRole("button", { name: "Stage import" }).click();

    // ── Step 3: Preview ──────────────────────────────────────────────────────
    // Stats chips: "2 new"
    await expect(page.getByText("2 new")).toBeVisible({ timeout: 15_000 });

    // Commit
    await page.getByRole("button", { name: /Import 2 transactions?/i }).click();

    // After commit the wizard resets to "upload" state (onDone() increments key).
    // The success toast is transient (Sonner default 4s) and may dismiss before
    // Playwright can assert it. Instead verify the stable side-effect: the
    // import history entry appears and the inbox has the pending entries.
    await expect(
      page.getByText(/committed.*SBI/i),
    ).toBeVisible({ timeout: 15_000 });

    // ── Verify: inbox shows the imported entries ────────────────────────────
    await page.goto("/inbox");
    // The two imported rows appear as pending entries
    await expect(page.getByText(/Coffee Shop/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Salary/i)).toBeVisible();
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
