import { test, expect } from "@playwright/test";
import { postSms, SBI_BODY } from "./helpers";

/**
 * SMS → Inbox → Accept flow.
 *
 * 1. POST an SBI debit SMS via /api/ingest/sms
 * 2. Load /inbox — pending entry is visible with merchant + amount
 * 3. Click Accept — entry is committed, inbox empties
 *
 * Amount: −525.00 (U+2212 minus + ₹525.00; < ₹1,000 → paise kept)
 * Empty state text: "Inbox clear." (from inbox-client.tsx)
 */
test("an SMS-captured expense appears in the inbox and accepts into the ledger", async ({
  page,
  baseURL,
}) => {
  // Step 1: ingest the SMS
  const result = await postSms(baseURL!, [
    {
      sender: "AD-SBIUPI",
      body: SBI_BODY,
      receivedAt: "2026-06-05T10:00:00Z",
    },
  ]);
  expect(result.committed).toBe(1);

  // Step 2: view the pending entry in the inbox
  await page.goto("/inbox");

  // merchant name from SMS parse
  await expect(page.getByText(/EatSure/i)).toBeVisible();

  // amount: formatINR("-525.0000") → "−₹525.00" (U+2212, < ₹1,000 keeps paise)
  await expect(page.getByText("−₹525.00")).toBeVisible();

  // Step 3: accept the entry.
  // If the entry has no category the Accept button opens a "Choose category"
  // dialog (CategoryPickerDialog). Pick a category there so the entry commits.
  await page.getByRole("button", { name: "Accept" }).first().click();

  // If the category dialog appears, pick "Food & Dining" to satisfy the
  // needsCategory guard in EntryCard.handleAccept.
  const dialog = page.getByRole("dialog", { name: "Choose category" });
  const dialogVisible = await dialog.isVisible().catch(() => false);
  if (dialogVisible) {
    await dialog.getByRole("button", { name: "Food & Dining" }).click();
  }

  // The EatSure entry is accepted and should no longer appear in the inbox.
  // We don't assert "Inbox clear." because other tests may have left pending
  // import entries in the shared DB; instead verify the specific entry is gone.
  await expect(page.getByText(/EatSure/i)).not.toBeVisible({ timeout: 10_000 });
});
