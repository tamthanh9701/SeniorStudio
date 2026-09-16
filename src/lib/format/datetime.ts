/**
 * Deterministic date and time formatting for the Vietnam workspace (GMT+7).
 *
 * These values are rendered on the server and again in the browser, so the
 * output must not depend on the machine's locale or timezone: a local-time
 * format produces different text on each side and React reports a hydration
 * mismatch (error #418), discarding the server-rendered tree.
 *
 * Everything is therefore formatted for one fixed timezone and locale, and the
 * timezone is stated in the UI wherever an exact moment matters. The fixed zone
 * is Asia/Ho_Chi_Minh rather than the viewer's zone: the team reads these
 * timestamps in Vietnam time wherever they are.
 */
const TIME_ZONE = "Asia/Ho_Chi_Minh";
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

/** `YYYY-MM-DD` in the workspace timezone, for grouping jobs by day. */
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIME_ZONE,
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `12 Sep 2026, 17:09` in GMT+7. */
export function formatDateTime(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : null;
}

/** `17:09` in GMT+7, for compact timelines. */
export function formatTime(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : null;
}

/** `12 Sep 2026` in GMT+7. */
export function formatDate(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : null;
}

/**
 * Calendar day (`YYYY-MM-DD`) in the workspace timezone. Two moments belong to
 * the same day when their keys match, which is what "today" means in the UI.
 */
export function vnDayKey(value: string | number | Date | null | undefined): string | null {
  const date = toDate(value);
  return date ? dayKeyFormatter.format(date) : null;
}

/** Label used next to an exact timestamp so the fixed zone is not mistaken for local time. */
export const TIME_ZONE_LABEL = "GMT+7";
