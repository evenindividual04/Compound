import type { AccountKind } from "@/db/schema/core";

export const KIND_LABELS: Record<AccountKind, string> = {
  bank: "Bank account",
  cash: "Cash",
  credit_card: "Credit card",
  loan: "Loan",
  investment: "Investment",
  epf: "EPF",
  ppf: "PPF",
  fd: "Fixed deposit",
  property: "Property",
  gold: "Gold",
  crypto: "Crypto",
  wallet: "Wallet",
  receivable: "Receivable",
  other_asset: "Other asset",
  other_liability: "Other liability",
};

export const ALL_KINDS: AccountKind[] = [
  "bank",
  "cash",
  "credit_card",
  "loan",
  "investment",
  "epf",
  "ppf",
  "fd",
  "property",
  "gold",
  "crypto",
  "wallet",
  "receivable",
  "other_asset",
  "other_liability",
];
