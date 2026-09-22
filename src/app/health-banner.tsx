import Link from "next/link";

import type { HealthWarning } from "@/lib/health/workspace";

/**
 * What is wrong with the workspace right now, if anything, each with a link
 * to where it gets fixed. Nothing at all is shown when all is well.
 */
export function HealthBanner({ warnings }: { warnings: HealthWarning[] }) {
  if (!warnings.length) {
    return null;
  }

  return (
    <ul role="status" className="flex flex-col gap-2">
      {warnings.map((warning) => (
        <li
          key={warning.text}
          className={
            warning.level === "critical"
              ? "rounded-md border border-red-600/30 bg-red-600/5 px-4 py-3 text-sm"
              : "rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
          }
        >
          {warning.text}{" "}
          <Link href={warning.href} className="underline">
            Look at it
          </Link>
        </li>
      ))}
    </ul>
  );
}
