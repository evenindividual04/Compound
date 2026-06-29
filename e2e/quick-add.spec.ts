import { test, expect } from "@playwright/test";

/**
 * Quick-add flow: FAB → drawer → keypad → category → saved → ledger entry.
 *
 * No recent categories exist in a fresh DB so the "More…" Select is used
 * to pick "Food & Dining".
 *
 * Verifies:
 *   1. success toast "Saved" appears
 *   2. the ₹100 expense entry actually lands in /transactions (ledger write
 *      confirmed — a toast alone cannot rule out a failed server action)
 */
test("quick-add drawer records a new expense via the keypad and category select", async ({
  page,
}) => {
  // Navigate to the home page so the AppShell + FAB are rendered
  await page.goto("/");

  // Open the quick-entry drawer via the FAB
  await page.getByRole("button", { name: "Quick entry" }).click();

  // Wait for the drawer to be visible
  await expect(page.getByText("Quick Entry")).toBeVisible();

  // Enter amount: 1 0 0 (100 rupees) via the keypad buttons
  await page.getByRole("button", { name: "1" }).click();
  await page.getByRole("button", { name: "0" }).first().click();
  await page.getByRole("button", { name: "0" }).first().click();

  // The amount display should show ₹100.00
  await expect(page.getByText("₹100.00")).toBeVisible();

  // Open the "More…" category select and pick "Food & Dining".
  // The SelectTrigger renders as a combobox; open it by clicking the trigger.
  await page.getByRole("combobox").first().click();

  // base-ui SelectItem renders via a Portal. On a mobile viewport the popup may
  // render off-screen or with zero geometry. Dispatch a click event directly on
  // the underlying DOM element so the Select's value-change handler fires.
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('[role="option"]');
    for (const item of items) {
      if (item.textContent?.includes("Food & Dining")) return true;
    }
    return false;
  }, { timeout: 10_000 });
  await page.evaluate(() => {
    const items = document.querySelectorAll('[role="option"]');
    for (const item of items) {
      if (item.textContent?.includes("Food & Dining")) {
        (item as HTMLElement).click();
        return;
      }
    }
  });

  // After selecting a category, quickAddAction is called and the drawer closes.
  // The action dispatches a server action; we wait for the success toast.
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

  // Navigate to /transactions to confirm the entry actually landed in the ledger.
  // formatINR("-100.0000") = "−₹100.00" (U+2212 minus; < ₹1,000 → 2 decimal places).
  await page.goto("/transactions");
  // The amount "−₹100.00" uses U+2212 (typographic minus), not ASCII hyphen.
  await expect(page.getByText("−₹100.00")).toBeVisible({ timeout: 10_000 });
});
