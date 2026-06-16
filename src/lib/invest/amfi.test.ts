import { describe, it, expect } from "vitest";
import { parseAmfiNav } from "./amfi";

const SAMPLE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes ( Equity Scheme - Flexi Cap Fund )

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund - Regular Plan - Growth;65.4321;16-Jun-2026
122640;INF879O01035;-;Parag Parikh Flexi Cap Fund - Direct Plan - Growth;71.2345;16-Jun-2026

Some Other AMC

100001;INF000000001;-;Liquid Fund - Growth;1234.5678;16-Jun-2026
`;

describe("parseAmfiNav", () => {
  it("extracts code, nav, and ISO date for data lines and skips headers", () => {
    const out = parseAmfiNav(SAMPLE);
    expect(out.get("122639")).toEqual({ nav: "65.432100", date: "2026-06-16" });
    expect(out.get("122640")?.nav).toBe("71.234500");
    expect(out.get("100001")?.date).toBe("2026-06-16");
    expect(out.size).toBe(3);
  });

  it("ignores lines with non-numeric NAV", () => {
    const out = parseAmfiNav("999999;X;-;Broken Fund;N.A.;16-Jun-2026\n");
    expect(out.size).toBe(0);
  });
});
