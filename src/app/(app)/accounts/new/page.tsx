import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { todayIST } from "@/lib/dates";
import { NewAccountForm } from "@/components/accounts/new-account-form";

export default function NewAccountPage() {
  const today = todayIST();

  return (
    <div className="min-h-screen bg-paper px-4 pt-12 pb-8">
      <header className="mb-6 flex items-center gap-2">
        <Link
          href="/accounts"
          className="flex items-center gap-1 text-sm text-soft hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" />
          Accounts
        </Link>
      </header>

      <h1 className="font-display mb-1 text-3xl font-bold text-ink">Add account</h1>
      <p className="mb-8 text-sm text-soft">Track a new asset or liability.</p>

      <NewAccountForm today={today} />
    </div>
  );
}
