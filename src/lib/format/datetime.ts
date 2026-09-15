/**
 * Deterministic date and time formatting.
 *
 * These values are rendered on the server and again in the browser, so the
 * output must not depend on the machine's locale or timezone: a local-time
 * format produces different text on each side and React reports a hydration
 * mismatch (error #418), discarding the server-rendered tree.
 *
 * Everything is therefore formatted for a fixed timezone and locale, and the
 * timezone is stated in the UI wherever an exact moment matters.
 */
const TIME_ZONE = "UTC";
const LOCALE = "en-GB";

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeZone: TIME_ZONE,
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `12 Sep 2026, 17:09` in UTC. */
export function formatDateTime(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : null;
}

/** `17:09` in UTC, for compact timelines. */
export function formatTime(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : null;
}

/** `12 Sep 2026` in UTC. */
export function formatDate(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : null;
}

/** Label used next to an exact timestamp so the fixed zone is not mistaken for local time. */
export const TIME_ZONE_LABEL = "UTC";
