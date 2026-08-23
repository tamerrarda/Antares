/**
 * The calendar file, as data rather than as a side effect.
 *
 * `08-OFFCHAIN §3` cuts browser push and says why: push that arrives with the tab closed needs a
 * server holding subscriptions and watching the chain, and that **is** a backend of record — the one
 * thing this app's first architectural line says it does not have. A file the reader keeps touches
 * no funds, holds no keys, and is not a backend of anything.
 *
 * Kept out of the component so it can be tested: the format is fussy (CRLF line endings, escaped
 * commas, UTC stamps) and a calendar that no application will open is worse than none, because it
 * fails silently in somebody else's software.
 */

export interface Reminder {
  readonly uid: string;
  /** Unix seconds. Rendered as UTC, which is what the trailing `Z` means. */
  readonly at: bigint | number;
  readonly title: string;
  readonly body: string;
}

/** `20260821T163700Z` — RFC 5545's UTC form, with no punctuation and no milliseconds. */
export function stamp(unixSeconds: bigint | number): string {
  const iso = new Date(Number(unixSeconds) * 1000).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * RFC 5545 gives commas and semicolons meaning inside a property value, so a description that
 * contains one has to escape it or the rest of the sentence becomes a second value and disappears.
 */
function escapeText(value: string): string {
  // `"\;"` in a JS string literal is just `";"` — the backslash is dropped, so a replacement written
  // that way escapes nothing. The linter caught it; the test did not, because `includes("\;")` is
  // `includes(";")` and passes on any string containing a semicolon at all.
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Line endings are CRLF, which the spec requires and which several parsers enforce. */
export function calendar(reminders: readonly Reminder[]): string {
  const out: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Antares//Vault//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const r of reminders) {
    out.push(
      "BEGIN:VEVENT",
      `UID:${r.uid}@antares`,
      `DTSTAMP:${stamp(r.at)}`,
      `DTSTART:${stamp(r.at)}`,
      "DURATION:PT15M",
      `SUMMARY:${escapeText(r.title)}`,
      `DESCRIPTION:${escapeText(r.body)}`,
      "END:VEVENT",
    );
  }
  out.push("END:VCALENDAR");
  return `${out.join("\r\n")}\r\n`;
}
