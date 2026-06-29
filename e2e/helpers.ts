/**
 * E2E test helpers.
 *
 * DB lifecycle: globalSetup (e2e/global-setup.ts) truncates and re-seeds the
 * compound_e2e database ONCE before the full test run. There is NO per-spec
 * reset — specs run serially (workers: 1) and each spec uses distinct data
 * (different amounts, senders, dates) so they do not interfere with each other.
 *
 * SBI UPI debit SMS fixture.
 * Amount: 525.00 → formatINR("-525.0000") = "−₹525.00"
 * (U+2212 minus, < ₹1,000 threshold → keeps 2 decimal places)
 */
export const SBI_BODY =
  "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 -SBI";

export async function postSms(
  baseURL: string,
  messages: { sender: string; body: string; receivedAt: string }[],
): Promise<{ committed: number; [k: string]: unknown }> {
  const res = await fetch(`${baseURL}/api/ingest/sms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01"}`,
    },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/ingest/sms failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ committed: number; [k: string]: unknown }>;
}
