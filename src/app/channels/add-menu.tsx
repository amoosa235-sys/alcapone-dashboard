import type { ReactNode } from "react";

/**
 * One "add an account" dropdown. It is a plain <details>, so it opens and
 * closes without any client JavaScript and works before the page hydrates.
 */
export function AddMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-black/10 dark:border-white/15">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {label}
        <span
          aria-hidden
          className="text-xs text-black/40 transition-transform group-open:rotate-180 dark:text-white/40"
        >
          &#9662;
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-black/10 px-4 py-4 dark:border-white/15">
        {children}
      </div>
    </details>
  );
}

/**
 * One choice inside a menu. `note` is where a choice that cannot be used yet
 * says why, rather than being left out of the list.
 */
export function MenuOption({
  name,
  note,
  children,
}: {
  name: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{name}</span>
        {note ? (
          <span className="shrink-0 rounded-full border border-black/10 px-2 py-0.5 text-[11px] text-black/50 dark:border-white/15 dark:text-white/50">
            {note}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
