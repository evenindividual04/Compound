import Link from "next/link";

export function AddCardTile() {
  return (
    <Link
      href="/browse"
      className="flex items-center justify-center gap-[7px] rounded-2xl"
      style={{
        margin: "0 16px 10px",
        border: "1.5px dashed var(--hairline)",
        borderRadius: "16px",
        padding: "14px 15px",
      }}
    >
      <span className="text-soft" style={{ fontSize: "16px", lineHeight: 1 }}>
        ＋
      </span>
      <span className="text-[12px] font-semibold text-soft">Add a card</span>
    </Link>
  );
}
