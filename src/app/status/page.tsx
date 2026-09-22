import Link from "next/link";

import { checkHealth } from "@/lib/health/deploy";

export const metadata = { title: "Pipeline check" };
export const dynamic = "force-dynamic";

/**
 * Whether the deploy is wired up: environment variables present and Supabase
 * reachable. Public on purpose, so it can be checked without signing in, and
 * it reports only presence, never a value.
 */
export default async function StatusPage() {
  const report = await checkHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pipeline check
        </h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Environment and database connectivity for this deploy.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-5 dark:border-white/15">
        <Row
          label="Supabase connection"
          ok={report.supabase.reachable}
          detail={report.supabase.error ?? "round trip succeeded"}
        />
        {Object.entries(report.env).map(([name, present]) => (
          <Row
            key={name}
            label={name}
            ok={present}
            detail={present ? "set" : "missing"}
          />
        ))}
      </section>

      <p className="text-xs text-black/50 dark:text-white/50">
        Checked {report.checkedAt}. Machine-readable at{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>
        . <Link className="underline" href="/">
          Back to the dashboard
        </Link>
        .
      </p>
    </main>
  );
}

function Row({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="font-mono">{label}</span>
      <span className={ok ? "text-green-600" : "text-red-600"}>
        {ok ? "ok" : "fail"} &middot;{" "}
        <span className="text-black/50 dark:text-white/50">{detail}</span>
      </span>
    </div>
  );
}
