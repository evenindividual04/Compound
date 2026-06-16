import { requireHousehold } from "@/lib/current";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function SettingsPage() {
  const { email } = await requireHousehold();

  return (
    <div className="bg-paper min-h-screen px-4 pt-6 pb-4">
      <h1 className="font-display text-3xl font-bold text-ink">More</h1>
      <p className="mt-1 text-sm text-soft">Signed in as {email}.</p>

      <section className="mt-6">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
          Appearance
        </p>
        <div className="rounded-2xl border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink">Theme</span>
            <ThemeToggle />
          </div>
        </div>
      </section>
    </div>
  );
}
