import { BottomNav } from "@/components/bottom-nav";
import { InstallCoachMark } from "@/components/install-coach-mark";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <main className="flex-1 pb-20">{children}</main>
      <BottomNav />
      <a
        href="#"
        id="quick-entry-fab"
        aria-label="Quick entry"
        className="fixed bottom-20 left-1/2 z-50 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-2xl font-light text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        +
      </a>
      <InstallCoachMark />
    </>
  );
}
