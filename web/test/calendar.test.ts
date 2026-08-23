/**
 * The calendar file's format, which fails in somebody else's software when it fails.
 *
 * A malformed `.ics` does not error — it opens to nothing, or drops the half of a description that
 * followed a comma. That is exactly the failure a browser check cannot see, so the format is
 * asserted here instead of eyeballed after a download.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { calendar, stamp } from "../lib/calendar.ts";

const AT = 1_787_416_620; // a real ledger close time from the deployed vault

test("timestamps are RFC 5545 UTC, with no punctuation and no milliseconds", () => {
  assert.match(stamp(AT), /^\d{8}T\d{6}Z$/);
  assert.equal(stamp(AT), stamp(BigInt(AT)), "a bigint and a number must produce the same stamp");
});

test("the file is wrapped, CRLF-terminated, and carries one VEVENT per reminder", () => {
  const text = calendar([
    { uid: "a", at: AT, title: "one", body: "first" },
    { uid: "b", at: AT + 600, title: "two", body: "second" },
  ]);
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.trimEnd().endsWith("END:VCALENDAR"));
  assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.equal((text.match(/DTSTART:/g) ?? []).length, 2);
  // Every line ends CRLF — a lone LF is what several parsers refuse.
  for (const line of text.split("\r\n").slice(0, -1)) assert.ok(!line.includes("\n"), `bare LF in: ${line}`);
});

test("commas and semicolons in a description survive, because RFC 5545 gives them meaning", () => {
  const body = "If nobody bids, your window opens; otherwise it runs to expiry.";
  const text = calendar([{ uid: "x", at: AT, title: "t", body }]);
  const line = text.split("\r\n").find((l) => l.startsWith("DESCRIPTION:")) ?? "";
  // Asserted as the two characters they must actually be. Writing `"\;"` here is what made the
  // previous version of this test a tautology: it compiles to `";"` and passes on any semicolon.
  assert.ok(line.includes("\\,"), "a comma must be escaped or the rest of the sentence is dropped");
  assert.ok(line.includes("\\;"), "a semicolon must be escaped for the same reason");
  // And the sentence is still all on one property.
  assert.ok(line.endsWith("expiry."), `the description was truncated: ${line}`);
});

test("an empty reminder list still produces a valid, empty calendar", () => {
  const text = calendar([]);
  assert.ok(text.startsWith("BEGIN:VCALENDAR"));
  assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 0);
});
