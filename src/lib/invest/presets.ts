/** Column-role presets for broker tradebook CSV/Excel exports. Saved into import_configs. */
export const TRADE_PRESETS = {
  zerodha_console: {
    label: "Zerodha Console (tradebook)",
    dateFormat: "yyyy-MM-dd" as const,
    roles: { date: "trade_date", instrumentSymbol: "symbol", side: "trade_type", units: "quantity", price: "price" },
  },
  groww: {
    label: "Groww (order history)",
    dateFormat: "dd MMM yyyy" as const,
    roles: { date: "Date", instrumentSymbol: "Stock/Scheme", side: "Type", units: "Quantity", price: "Price" },
  },
} as const;
