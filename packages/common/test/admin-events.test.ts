/**
 * The administrative decoders, against payloads taken off the chain rather than off the spec.
 *
 * Every fixture below was captured from the deployed testnet vault on 2026-08-22. That matters:
 * §14's table describes `upgraded` as a map `{wasm_hash, app_version}` and the contract emits a
 * positional tuple. A decoder written from the table would have typechecked, passed a hand-written
 * test built from the same misreading, and failed the first time somebody upgraded a vault.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeAdminEvent,
  isAdminEventName,
  isTokenEvent,
  isUnrecognised,
  type RawEvent,
} from "../events.ts";

/*
 * Addresses are distinctive placeholders, not `G…`/`C…` literals, for two reasons and the second is
 * the better one. `06-TEST-PLAN §8`'s network-agnostic check keeps real addresses out of TypeScript
 * except in `packages/common/networks.ts` and `deployments/*.json`, and its own comment says the
 * exemption is the point of the rule rather than a hole in it. And `asAddress` does not validate the
 * format anyway — so a placeholder that names *where the value came from* proves more than a real
 * address would: it shows which input reached which field, which is exactly what these decoders get
 * wrong when they get anything wrong.
 */
const base = { txHash: "abc", ledger: 4258216, ledgerClosedAt: "2026-08-21T12:00:18Z" } as const;
const raw = (topics: readonly unknown[], data: unknown): RawEvent => ({ ...base, topics, data });

test("paused and unpaused carry who did it", () => {
  const who = "address-from-the-by-field";
  assert.deepEqual(decodeAdminEvent(raw(["paused"], { by: who })), { name: "paused", by: who });
  assert.deepEqual(decodeAdminEvent(raw(["unpaused"], { by: who })), { name: "unpaused", by: who });
});

test("allowed_changed takes its bidder from the topic and its flag from the whole payload", () => {
  // The payload is the boolean itself, not a map with a field in it.
  const bidder = "address-from-the-topic";
  assert.deepEqual(decodeAdminEvent(raw(["allowed_changed", bidder], true)), {
    name: "allowed_changed",
    bidder,
    allowed: true,
  });
});

test("upgraded is a positional tuple, not a map", () => {
  const hash = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
  const out = decodeAdminEvent(raw(["upgraded"], [hash, 1]));
  assert.equal(out.name, "upgraded");
  assert.equal(isUnrecognised(out), false);
  assert.equal(
    "wasmHash" in out ? out.wasmHash : null,
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
});

test("initialized carries the configuration a vault was born with", () => {
  const out = decodeAdminEvent(
    raw(["initialized"], {
      admin: "the-admin",
      asset: "the-asset",
      oracle: "the-oracle",
      fee_recipient: "the-fee-recipient",
      deposit_cap: 1_000_000_000_000n,
      fee_bps: 0,
      allowlist_enabled: true,
      allowlist_expires_at: 1_788_477_073n,
      app_version: 1,
      paused: false,
    }),
  );
  assert.equal(out.name, "initialized");
  assert.equal("feeBps" in out ? out.feeBps : -1, 0);
  assert.equal("allowlistExpiresAt" in out ? out.allowlistExpiresAt : -1, 1_788_477_073);
});

test("an admin event this build does not know is surfaced, not swallowed", () => {
  // Completeness is the operator log's entire claim. A name we cannot decode is still an action
  // somebody took, and hiding it would be the one failure the page cannot afford.
  const out = decodeAdminEvent(raw(["cap_changed"], { old: 1n, new: 2n }));
  assert.equal(isUnrecognised(out), true);
  assert.equal(out.name, "cap_changed");
  assert.deepEqual(isUnrecognised(out) ? out.data : null, { old: 1n, new: 2n });
});

test("a known name whose shape has changed falls back rather than throwing", () => {
  const out = decodeAdminEvent(raw(["upgraded"], { wasm_hash: "nope" }));
  assert.equal(isUnrecognised(out), true, "a map-shaped `upgraded` must not crash the log");
});

test("token events are named as such so an operator log can leave them out", () => {
  assert.equal(isTokenEvent("mint"), true);
  assert.equal(isTokenEvent("burn"), true);
  assert.equal(isTokenEvent("paused"), false);
  assert.equal(isAdminEventName("paused"), true);
  assert.equal(isAdminEventName("mint"), false);
});
