/**
 * Tests for the pass and for how a refusal is classified.
 *
 * The fake client is the point: every branch below is a rejection the contract really produces, and
 * none of them needs a testnet round to reach. The two that matter most are the ones with no
 * equivalent in `keeper/errors.ts` — `blocked`, which stops the loop, and `mirror_bug`, which stops
 * it louder because it means this package's copy of a contract rule has drifted.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classify } from "../errors.ts";
import { pass, type Sink } from "../runner.ts";
import { flatStrategy, type AuctionView, type RiskCaps } from "../strategy.ts";
import { diagnosticContractCode } from "../vault.ts";
import type { AllowlistState, BidderVaultClient } from "../vault.ts";

const XLM = 10_000_000n;
const caps: RiskCaps = { maxNotional: 400n * XLM, maxPortfolioNotional: 900n * XLM };
const strategy = flatStrategy(100);

const auction: AuctionView = {
  round: 7,
  phase: "Auction",
  currentPremiumBps: 80,
  notionalOffered: 1_000n * XLM,
  notionalSold: 0n,
  minFill: 100n * XLM,
};

interface FakeOptions {
  readonly allowlist?: AllowlistState;
  readonly listed?: boolean;
  readonly open?: bigint;
  readonly bidError?: Error;
  readonly view?: Partial<AuctionView>;
}

function fake(options: FakeOptions = {}): { client: BidderVaultClient; calls: string[] } {
  const calls: string[] = [];
  const client: BidderVaultClient = {
    id: "CVAULT",
    address: "GBIDDER",
    auction: async () => {
      calls.push("auction");
      return { ...auction, ...options.view };
    },
    allowlist: async () => {
      calls.push("allowlist");
      return options.allowlist ?? { enabled: false, expiresAt: 0 };
    },
    isListed: async () => {
      calls.push("isListed");
      return options.listed ?? false;
    },
    openNotional: async () => {
      calls.push("openNotional");
      return options.open ?? 0n;
    },
    bid: (notional, maxPremiumBps) => {
      calls.push(`bid:${notional}:${maxPremiumBps}`);
      return options.bidError === undefined ? Promise.resolve("TXHASH") : Promise.reject(options.bidError);
    },
  };
  return { client, calls };
}

const now = 1_000;
const run = (o: FakeOptions = {}) => {
  const f = fake(o);
  return pass(f.client, { caps, strategy, now }).then((r) => ({ ...r, calls: f.calls }));
};

test("a clean pass bids and reports the hash", async () => {
  const r = await run();
  assert.equal(r.txHash, "TXHASH");
  assert.equal(r.disposition, null);
  assert.ok(r.calls.includes(`bid:${400n * XLM}:100`));
});

test("a wait sends nothing at all", async () => {
  const r = await run({ view: { phase: "Idle" } });
  assert.equal(r.decision.kind, "wait");
  assert.equal(r.txHash, null);
  assert.equal(
    r.calls.some((c) => c.startsWith("bid:")),
    false,
  );
});

// --- the allowlist mirror, in the same three parts the contract writes it ------------------------

test("a disabled gate is not consulted further", async () => {
  const r = await run({ allowlist: { enabled: false, expiresAt: 9_999 }, listed: false });
  // Reading membership would imply the answer mattered. It does not.
  assert.equal(r.calls.includes("isListed"), false);
  assert.equal(r.allowed, true);
});

test("an EXPIRED gate is inert even while enabled — the clause that must not be dropped", async () => {
  // `auction.rs` refuses only while the gate is enabled AND `now < allowlist_expires_at`. A mirror
  // missing the expiry clause declines business the contract would have taken, silently.
  const r = await run({ allowlist: { enabled: true, expiresAt: now }, listed: false });
  assert.equal(r.allowed, true);
  assert.equal(r.calls.includes("isListed"), false);
  assert.equal(r.txHash, "TXHASH");
});

test("a live gate consults membership, and refuses without sending when absent", async () => {
  const r = await run({ allowlist: { enabled: true, expiresAt: now + 1 }, listed: false });
  assert.equal(r.allowed, false);
  assert.equal(r.decision.kind, "wait");
  assert.equal(
    r.calls.some((c) => c.startsWith("bid:")),
    false,
  );
});

test("a live gate with membership bids", async () => {
  const r = await run({ allowlist: { enabled: true, expiresAt: now + 1 }, listed: true });
  assert.equal(r.allowed, true);
  assert.equal(r.txHash, "TXHASH");
});

// --- refusals -----------------------------------------------------------------------------------

const refusal = (code: number) => new Error(`HostError: Error(Contract, #${code})`);

test("losing the race is benign, not a failure", async () => {
  const r = await run({ bidError: refusal(2) });
  assert.equal(r.disposition?.kind, "benign");
});

test("our own slippage guard tripping is benign — nothing was bought at a price we did not name", async () => {
  const r = await run({ bidError: refusal(31) });
  assert.equal(r.disposition?.kind, "benign");
});

test("in-the-money is transient, because spot can fall back inside the same auction", async () => {
  const r = await run({ bidError: refusal(34) });
  assert.equal(r.disposition?.kind, "transient");
});

test("an unreachable feed is transient and is NOT absent demand", async () => {
  const r = await run({ bidError: refusal(13) });
  assert.equal(r.disposition?.kind, "transient");
  assert.match(r.disposition?.why ?? "", /NOT absent demand/);
});

test("the allowlist refusing is blocked — only the admin can change it", async () => {
  const r = await run({ bidError: refusal(30) });
  assert.equal(r.disposition?.kind, "blocked");
});

test("BelowMinFill and ZeroPremium are mirror bugs, because decide() claims to prevent both", async () => {
  for (const code of [32, 35]) {
    const r = await run({ bidError: refusal(code) });
    assert.equal(r.disposition?.kind, "mirror_bug", `code ${code}`);
  }
});

test("a transport failure is not read as a contract rejection", async () => {
  const r = await run({ bidError: new Error("fetch failed") });
  assert.equal(r.disposition?.kind, "unexpected");
  assert.equal(r.disposition?.code, null);
});

test("an unexpected verdict carries the failure that caused it", async () => {
  // Measured on testnet 2026-08-23: a submission rejected before execution stopped the loop with
  // "no contract error code in this failure" and nothing else, so there was no way to tell a bad
  // sequence number from a dead RPC. The verdict has to bring the cause with it.
  const r = await run({ bidError: new Error("send rejected before execution: txBadSeq (status ERROR)") });
  assert.equal(r.disposition?.kind, "unexpected");
  assert.match(r.disposition?.why ?? "", /txBadSeq/);
});

test("an unknown contract code brings its message too, not just its number", () => {
  const d = classify(new Error("HostError: Error(Contract, #54) VaultWorthless"));
  assert.equal(d.kind, "unexpected");
  assert.match(d.why, /VaultWorthless/);
});

test("a multi-line failure is flattened and bounded, so one refusal cannot flood a log", () => {
  const noisy = new Error(`boom\n${"x".repeat(1_000)}`);
  const d = classify(noisy);
  assert.equal(d.why.includes("\n"), false);
  assert.ok(d.why.length < 400, `why was ${d.why.length} chars`);
});

test("an unknown contract code keeps its number, so the report names it", () => {
  const d = classify(refusal(54));
  assert.equal(d.kind, "unexpected");
  assert.equal(d.code, 54);
});

test("a refusal that is not an Error at all is still classified", () => {
  // The fake above rejects with `Error`s because that is what these tests need. What the SDK
  // actually hands back is not always one, which is why `classify` takes `unknown` — asserted here
  // rather than left to the type signature to imply.
  assert.equal(classify("HostError: Error(Contract, #30)").kind, "blocked");
  assert.equal(classify({ message: "Error(Contract, #2)" }).kind, "benign");
  assert.equal(classify(undefined).kind, "unexpected");
});

// --- the portfolio total reaches the decision ----------------------------------------------------

test("what the client reports as open notional is what bounds the bid", async () => {
  const r = await run({ open: 800n * XLM });
  assert.equal(r.openNotional, 800n * XLM);
  assert.ok(r.calls.includes(`bid:${100n * XLM}:100`));
});

// A sink that records, for anyone extending these tests to the loop itself.
export const recordingSink = (): { sink: Sink; lines: string[] } => {
  const lines: string[] = [];
  const push = (level: string) => (m: string) => lines.push(`${level} ${m}`);
  return {
    lines,
    sink: { debug: push("debug"), info: push("info"), warn: push("warn"), alert: push("alert") },
  };
};

// --- the diagnostic-event walk, which took two attempts to get right -----------------------------

test("the contract code is recovered from a failed transaction's diagnostic events", () => {
  // Shapes mimic the SDK's XDR objects: methods, not fields.
  const sym = { switch: () => ({ name: "scvSymbol" }), error: () => null };
  const errTopic = {
    switch: () => ({ name: "scvError" }),
    error: () => ({ switch: () => ({ name: "sceContract" }), contractCode: () => 2 }),
  };
  const event = (topics: unknown[]) => ({
    event: () => ({ body: () => ({ v0: () => ({ topics: () => topics }) }) }),
  });
  assert.equal(diagnosticContractCode({ diagnosticEventsXdr: [event([sym, errTopic])] }), 2);
});

test("one event with a body variant that throws does not abort the scan", () => {
  // The regression, exactly. A failed invocation carries around twenty events and not all share a
  // body variant; a single `try` around the whole walk let the first thrower report "no contract
  // code" on a transaction that plainly had one.
  const throwing = {
    event: () => ({
      body: () => ({
        v0: () => {
          throw new Error("v0 not set");
        },
      }),
    }),
  };
  const errTopic = {
    switch: () => ({ name: "scvError" }),
    error: () => ({ switch: () => ({ name: "sceContract" }), contractCode: () => 34 }),
  };
  const good = {
    event: () => ({ body: () => ({ v0: () => ({ topics: () => [errTopic] }) }) }),
  };
  assert.equal(diagnosticContractCode({ diagnosticEventsXdr: [throwing, good] }), 34);
});

test("no diagnostic events is not a code of zero", () => {
  assert.equal(diagnosticContractCode({}), null);
  assert.equal(diagnosticContractCode({ diagnosticEventsXdr: [] }), null);
});
