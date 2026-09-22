/**
 * Whether tickets are actually flowing for a workspace, as opposed to
 * whether the deploy is configured (deploy.ts).
 *
 * The deploy check can be green while every mailbox is in error and nothing
 * has arrived for a week. This is the check that notices: a channel in
 * error, a mailbox that has stopped syncing, a Microsoft client secret about
 * to run out, the scheduler going quiet, tickets Claude gave up on, and
 * replies stuck part way out.
 */

export type HealthLevel = "critical" | "warning";

export type HealthWarning = {
  level: HealthLevel;
  text: string;
  href: string;
};

export type WorkspaceHealthInput = {
  channels: {
    type: string;
    status: string;
    display_name: string;
    last_error: string | null;
    last_synced_at: string | null;
    config: unknown;
  }[];
  lastJobRunAt: string | null;
  failedClassifications: number;
  stuckSends: number;
};

/** How long a mailbox can go without a successful check before it is news. */
export const STALE_SYNC_HOURS = 3;

/** The scheduler calls the job every few minutes; this long means it stopped. */
export const STALE_JOB_MINUTES = 30;

/** How far ahead a client secret's expiry starts showing. */
export const SECRET_WARNING_DAYS = 30;

function hoursSince(iso: string | null, now: Date): number {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const then = Date.parse(iso);
  return Number.isFinite(then) ? (now.getTime() - then) / 3_600_000 : Number.POSITIVE_INFINITY;
}

function configDate(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function secretExpiry(config: unknown): string | null {
  return configDate(config, "expires_on");
}

export function workspaceWarnings(
  input: WorkspaceHealthInput,
  now: Date = new Date(),
): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  for (const channel of input.channels) {
    const name = channel.display_name;

    if (channel.status === "error") {
      warnings.push({
        level: "critical",
        text: `${name} has stopped: ${channel.last_error ?? "it reported an error"}.`,
        href: "/channels",
      });
      continue;
    }

    if (channel.status === "disabled") {
      warnings.push({
        level: "warning",
        text: `${name} is disabled${channel.last_error ? `: ${channel.last_error}` : "."}`,
        href: "/channels",
      });
      continue;
    }

    if (channel.type === "outlook" && channel.status === "connected") {
      const hours = hoursSince(configDate(channel.config, "last_checked_at"), now);
      if (hours > STALE_SYNC_HOURS) {
        warnings.push({
          level: "warning",
          text: Number.isFinite(hours)
            ? `${name} has not been checked for ${Math.floor(hours)} hours.`
            : `${name} has never been checked.`,
          href: "/channels",
        });
      }
    }

    const expires = secretExpiry(channel.config);
    if (expires) {
      const days = (Date.parse(expires) - now.getTime()) / 86_400_000;
      if (days < 0) {
        warnings.push({
          level: "critical",
          text: `The Microsoft client secret for ${name} expired on ${expires.slice(0, 10)}. Mail stops until a new one is entered.`,
          href: "/channels",
        });
      } else if (days <= SECRET_WARNING_DAYS) {
        warnings.push({
          level: "warning",
          text: `The Microsoft client secret for ${name} expires in ${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"}. Make a new one and enter it before then.`,
          href: "/channels",
        });
      }
    }
  }

  const hasLiveChannel = input.channels.some(
    (channel) => channel.status === "connected" || channel.status === "error",
  );
  if (hasLiveChannel) {
    const minutes = hoursSince(input.lastJobRunAt, now) * 60;
    if (minutes > STALE_JOB_MINUTES) {
      warnings.push({
        level: "warning",
        text: input.lastJobRunAt
          ? `The automatic check last ran ${formatAgo(minutes)} ago, so new mail and retries are waiting.`
          : "The automatic check has not run yet, so mail only arrives when someone presses Check now.",
        href: "/channels",
      });
    }
  }

  if (input.stuckSends > 0) {
    warnings.push({
      level: "critical",
      text: `${input.stuckSends} repl${input.stuckSends === 1 ? "y" : "ies"} may or may not have reached the customer. Open ${input.stuckSends === 1 ? "it" : "them"} to settle it.`,
      href: "/tickets?stuck=1",
    });
  }

  if (input.failedClassifications > 0) {
    warnings.push({
      level: "warning",
      text: `Claude could not sort ${input.failedClassifications} ticket${input.failedClassifications === 1 ? "" : "s"}. They are in the inbox unsorted.`,
      href: "/tickets?sorting=failed",
    });
  }

  return warnings.sort((a, b) =>
    a.level === b.level ? 0 : a.level === "critical" ? -1 : 1,
  );
}

function formatAgo(minutes: number): string {
  if (minutes < 120) {
    return `${Math.round(minutes)} minutes`;
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return `${Math.round(hours)} hours`;
  }
  return `${Math.round(hours / 24)} days`;
}
