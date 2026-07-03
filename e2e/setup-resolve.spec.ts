import { test, expect } from "@playwright/test";
import { postSms } from "./helpers";

/**
 * An SMS matching no existing account's smsKey lands as a sms_unmapped
 * anomaly. The Setup page lets you assign it to an existing account, which
 * commits it as a real pending transaction and removes it from the list.
 *
 * Uses acctKey "ICICI-CC:9999" (unused by any other spec) and merchant
 * "Uniquemart Resolve Test" (searchable, collision-free) so this test is
 * safe to run against the shared, non-reset e2e database.
 */
test("resolving an unmapped SMS anomaly assigns it to an account and creates a transaction", async ({
  page,
  baseURL,
}) => {
  const UNMAPPED_BODY =
    "INR 777.00 spent using ICICI Bank Card XX9999 on 05-Jun-26 on Uniquemart Resolve Test. Avl Limit: INR 5,000.00";

  const result = await postSms(baseURL!, [
    { sender: "AD-ICICIB", body: UNMAPPED_BODY, receivedAt: "2026-06-05T10:00:00Z" },
  ]);
  expect(result.unmapped).toBe(1);

  await page.goto("/browse/setup");
  await expect(page.getByText(/ICICI-CC:9999/)).toBeVisible();

  // Pick the first available account from the dropdown and resolve.
  await page.locator("button", { hasText: "Account" }).first().click();
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: "Resolve" }).first().click();

  await expect(page.getByText(/ICICI-CC:9999/)).not.toBeVisible({ timeout: 10_000 });

  await page.goto("/inbox");
  await expect(page.getByText(/Uniquemart Resolve Test/i)).toBeVisible();
});
