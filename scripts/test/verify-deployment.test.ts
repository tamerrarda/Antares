/**
 * Tests for `09-DEPLOYMENT.md` §2 step 5's battery.
 *
 * THE SHAPE OF THIS FILE IS THE POINT. Step 5 is a list of gates, and a gate only ever exercised
 * in the passing direction is a gate nobody has tested (`DEV-PROTOCOL.md` §6). So the fixture below
 * builds one healthy deployment, every test perturbs exactly one field of it, and asserts that the
 * corresponding check — **and only it** — fails. A test that merely asserted "the battery failed"
 * would pass just as happily against a battery that fails on everything.
 *
 * No network. The `ChainClient` port is filled by {@link FakeChain}, which serves values from a
 * plain object; that is what makes the failing direction reachable at all, since there is no way to
 * ask a live testnet for a vault whose `fee_bps` is 30.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEAD_SHARES,
  DEPOSIT_EVENTS,
  GENESIS_APP_VERSION,
  IDLE_WITHDRAW_EVENTS,
  MAX_ALLOWLIST_WINDOW,
  ONE_XLM,
  PRECISION,
  comparedParams,
  eventNames,
  observedEventName,
  phaseName,
  renderChecks,
  sameValue,
  verifyDeployment,
  verifyGenesis,
  verifyInitializedEvent,
  verifySmokeRoundTrip,
  type Check,
  type ChainClient,
  type GenesisExpectation,
  type InvokeOutcome,
  type ObservedEvent,
} from "../verify-deployment.ts";

// =================================================================================================
// The fixture: one healthy deployment of instance A
// =================================================================================================

const NOW = 1_800_000_000;
const VAULT = "CVAULT";
const SAC = "CASSET";
const ORACLE = "CORACLE";
const ADMIN = "GADMIN";
const FEE_RECIPIENT = "GFEE";

/** A full sixteen-field EpochParams, as the constructor takes it. */
const PARAMS: Readonly<Record<string, number>> = {
  epoch_duration: 604_800,
  auction_duration: 21_600,
  min_idle_gap: 14_400,
  strike_bps_otm: 300,
  premium_start_bps: 450,
  premium_floor_bps: 40,
  twap_window: 300,
  guard_window: 900,
  max_staleness: 600,
  max_deviation_bps: 100,
  oracle_dead_after: 7_200,
  settle_grace: 1_800,
  unresolved_after: 86_400,
  min_fill: 10_000_000,
  min_deposit: 100_000_000,
  settle_bounty_bps: 25,
};

const EXPECTED: GenesisExpectation = {
  vaultId: VAULT,
  admin: ADMIN,
  asset: SAC,
  oracle: ORACLE,
  feeRecipient: FEE_RECIPIENT,
  tokenSuffix: "-A",
  depositCap: 1_000_000_000_000n,
  rentThreshold: 100,
  rentExtendTo: 5_000,
  allowlistExpiresAt: NOW + 14 * 86_400,
  params: PARAMS,
};

interface VaultState {
  epoch: Record<string, unknown>;
  config: Record<string, unknown>;
  decimals: number;
  symbol: string;
  totalAssets: bigint;
  balance: bigint;
}

function healthyState(): VaultState {
  return {
    epoch: {
      round: 0,
      phase: ["Idle"],
      outcome_pending: false,
      notional_offered: 0n,
      notional_sold: 0n,
      premium_collected: 0n,
      locked_assets: 0n,
      shares_outstanding: 0n,
      last_pps: PRECISION,
      last_finalize_time: 0n,
    },
    config: {
      admin: ADMIN,
      pending_admin: null,
      asset: SAC,
      oracle: ORACLE,
      fee_recipient: FEE_RECIPIENT,
      fee_bps: 0,
      deposit_cap: EXPECTED.depositCap,
      deposit_headroom: EXPECTED.depositCap,
      paused: false,
      allowlist_enabled: true,
      allowlist_expires_at: BigInt(EXPECTED.allowlistExpiresAt),
      app_version: GENESIS_APP_VERSION,
      params: { ...PARAMS },
      rent_threshold: EXPECTED.rentThreshold,
      rent_extend_to: EXPECTED.rentExtendTo,
    },
    decimals: 7,
    symbol: "aXLM-A",
    totalAssets: 0n,
    balance: 500n * ONE_XLM,
  };
}

function initializedEvent(over: Record<string, unknown> = {}): ObservedEvent {
  return {
    topics: ["initialized"],
    data: {
      admin: ADMIN,
      asset: SAC,
      oracle: ORACLE,
      fee_recipient: FEE_RECIPIENT,
      token_suffix: "-A",
      deposit_cap: EXPECTED.depositCap,
      rent_threshold: EXPECTED.rentThreshold,
      rent_extend_to: EXPECTED.rentExtendTo,
      allowlist_expires_at: BigInt(EXPECTED.allowlistExpiresAt),
      params: { ...PARAMS },
      fee_bps: 0,
      paused: false,
      allowlist_enabled: true,
      app_version: GENESIS_APP_VERSION,
      ...over,
    },
  };
}

/**
 * A chain that answers from a mutable object.
 *
 * `invoke` models the two mutations step 5 performs, because the round-trip assertions are about
 * the *relationship* between what the deposit returned and what the withdraw returned — a stub
 * returning constants could not be made to fail for the reason a real rounding loss would.
 * `shortfall` is the knob that introduces one.
 */
interface FakeOptions {
  shortfall?: bigint;
  dropDepositEvent?: string;
  dropWithdrawEvent?: string;
  balanceGain?: bigint;
}

class FakeChain implements ChainClient {
  readonly reads: string[] = [];
  readonly invocations: string[] = [];
  readonly state: VaultState;
  readonly opts: FakeOptions;

  // Fields are assigned in the body rather than declared as parameter properties: `scripts/` runs
  // under `--experimental-strip-types`, whose erasable-syntax-only rule forbids them
  // (`06-TEST-PLAN.md` §8).
  constructor(state: VaultState, opts: FakeOptions = {}) {
    this.state = state;
    this.opts = opts;
  }

  read<T>(contractId: string, method: string, _args?: readonly unknown[]): Promise<T> {
    this.reads.push(`${contractId}.${method}`);
    if (contractId === SAC && method === "balance") return Promise.resolve(this.state.balance as T);
    switch (method) {
      case "epoch":
        return Promise.resolve(this.state.epoch as T);
      case "config":
        return Promise.resolve(this.state.config as T);
      case "decimals":
        return Promise.resolve(this.state.decimals as T);
      case "symbol":
        return Promise.resolve(this.state.symbol as T);
      case "total_assets":
        return Promise.resolve(this.state.totalAssets as T);
      default:
        throw new Error(`FakeChain has no answer for ${method}`);
    }
  }

  invoke<T>(contractId: string, method: string, args: readonly unknown[]): Promise<InvokeOutcome<T>> {
    this.invocations.push(`${contractId}.${method}`);
    if (method === "deposit") {
      const amount = args[1] as bigint;
      // D-36, modelled rather than ignored: the FIRST deposit pays for the dead-share floor out of
      // its own amount, and those shares are minted to the vault where nobody can withdraw them.
      // A fake that minted the whole amount would let a battery which forgot the floor pass here
      // and fail on the first real deploy — which is exactly what happened.
      const outstanding = this.state.epoch["shares_outstanding"] as bigint;
      const dead = outstanding === 0n ? DEAD_SHARES : 0n;
      const credited = amount - dead;
      this.state.totalAssets += amount;
      this.state.epoch["shares_outstanding"] = outstanding + amount;
      this.state.balance -= amount;
      const events = DEPOSIT_EVENTS.filter((n) => n !== this.opts.dropDepositEvent).map(
        (n): ObservedEvent => ({ topics: [n], data: {} }),
      );
      return Promise.resolve({ value: credited as T, events, txHash: "TXDEP" });
    }
    if (method === "request_withdraw") {
      const shares = args[1] as bigint;
      const paid = shares - (this.opts.shortfall ?? 0n);
      this.state.totalAssets -= shares;
      this.state.epoch["shares_outstanding"] = (this.state.epoch["shares_outstanding"] as bigint) - shares;
      this.state.balance += paid + (this.opts.balanceGain ?? 0n);
      const events = IDLE_WITHDRAW_EVENTS.filter((n) => n !== this.opts.dropWithdrawEvent).map(
        (n): ObservedEvent => ({ topics: [n], data: {} }),
      );
      return Promise.resolve({ value: paid as T, events, txHash: "TXWD" });
    }
    throw new Error(`FakeChain has no invocation for ${method}`);
  }
}

// The amount is explicit so the round-trip tests below keep testing the arithmetic they were
// written for. Left off, the amount now comes from the vault's own `min_deposit` — asserted on its
// own further down, because that default is what a real deploy uses.
const SMOKE = { account: ADMIN, assetId: SAC, amount: ONE_XLM };

function failed(checks: readonly Check[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => c.id);
}

/** Perturb one field, run the read-only battery, and name the checks that broke. */
async function genesisFailures(mutate: (s: VaultState) => void): Promise<string[]> {
  const state = healthyState();
  mutate(state);
  return failed(await verifyGenesis(new FakeChain(state), EXPECTED, NOW));
}

// =================================================================================================
// The healthy case
// =================================================================================================

test("a healthy genesis passes every read-only assertion", async () => {
  const checks = await verifyGenesis(new FakeChain(healthyState()), EXPECTED, NOW);
  assert.deepEqual(failed(checks), []);
  // Guard against the battery quietly shrinking to nothing: every gate step 5 names has to be here.
  const ids = new Set(checks.map((c) => c.id));
  for (const id of [
    "epoch.round",
    "epoch.phase",
    "token.decimals",
    "token.symbol",
    "vault.total_assets",
    "config.fee_bps",
    "config.paused",
    "config.allowlist_enabled",
    "config.allowlist_expires_at",
  ]) {
    assert.ok(ids.has(id), `step 5 names ${id} and the battery does not check it`);
  }
  assert.ok(checks.length >= 30, `expected a battery, got ${checks.length} checks`);
});

test("the whole step passes end to end and leaves the vault as it found it", async () => {
  const chain = new FakeChain(healthyState());
  const result = await verifyDeployment(chain, EXPECTED, NOW, [initializedEvent()], SMOKE);
  assert.deepEqual(failed(result.checks), []);
  assert.equal(result.passed, true);
  assert.deepEqual(chain.invocations, ["CVAULT.deposit", "CVAULT.request_withdraw"]);
  // Not zero: D-36's floor stays behind, which is the point of it.
  assert.equal(chain.state.totalAssets, DEAD_SHARES);
});

// =================================================================================================
// epoch()
// =================================================================================================

test("a vault that is not at round 0 fails, and only there", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.epoch["round"] = 3)), ["epoch.round"]);
});

test("a vault that is not Idle fails, and only there", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.epoch["phase"] = ["Auction"])), ["epoch.phase"]);
});

test("Idle at round 0 with shares outstanding is caught — the sentence alone would not catch it", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.epoch["shares_outstanding"] = 1n)), [
    "epoch.shares_outstanding",
  ]);
});

test("each genesis zero is checked separately", async () => {
  for (const field of [
    "notional_offered",
    "notional_sold",
    "premium_collected",
    "locked_assets",
    "last_finalize_time",
  ]) {
    assert.deepEqual(await genesisFailures((s) => (s.epoch[field] = 1n)), [`epoch.${field}`], field);
  }
});

test("a price per share that is not INITIAL_PPS fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.epoch["last_pps"] = PRECISION * 2n)), ["epoch.last_pps"]);
});

test("an outcome already pending fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.epoch["outcome_pending"] = true)), [
    "epoch.outcome_pending",
  ]);
});

// =================================================================================================
// decimals(), symbol(), total_assets()
// =================================================================================================

test("decimals other than 7 fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.decimals = 6)), ["token.decimals"]);
});

test("the symbol must carry this instance's suffix and not another's", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.symbol = "aXLM-B")), ["token.symbol"]);
  // D-52's actual failure mode: five vaults all showing as plain aXLM.
  assert.deepEqual(await genesisFailures((s) => (s.symbol = "aXLM")), ["token.symbol"]);
});

test("a vault that already holds assets fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.totalAssets = 1n)), ["vault.total_assets"]);
});

// =================================================================================================
// config() — the genesis constants
// =================================================================================================

test("a non-zero fee at genesis fails: the promise is that the fee ships at zero", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["fee_bps"] = 30)), ["config.fee_bps"]);
});

test("a vault shipped paused fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["paused"] = true)), ["config.paused"]);
});

test("a vault shipped with the allowlist off fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["allowlist_enabled"] = false)), [
    "config.allowlist_enabled",
  ]);
});

test("the allowlist window is bounded on both sides", async () => {
  // Beyond thirty days — D-63's cap, which step 5 states.
  const far = NOW + MAX_ALLOWLIST_WINDOW + 1;
  assert.deepEqual(
    await genesisFailures((s) => {
      s.config["allowlist_expires_at"] = BigInt(far);
    }),
    ["config.allowlist_expires_at", "config.allowlist_expires_at.passed"],
  );

  // Already expired. This is the bound step 5 does not state and the battery adds: the vault reads
  // allowlist_enabled == true and admits everyone, so the check above it passes and means nothing.
  const past = NOW - 1;
  assert.deepEqual(
    await genesisFailures((s) => {
      s.config["allowlist_expires_at"] = BigInt(past);
    }),
    ["config.allowlist_expires_at", "config.allowlist_expires_at.passed"],
  );

  // Exactly at the cap is admissible; exactly at `now` is not.
  const atCap = await genesisFailures((s) => {
    s.config["allowlist_expires_at"] = BigInt(NOW + MAX_ALLOWLIST_WINDOW);
  });
  assert.deepEqual(atCap, ["config.allowlist_expires_at.passed"]);
  const atNow = await genesisFailures((s) => {
    s.config["allowlist_expires_at"] = BigInt(NOW);
  });
  assert.ok(atNow.includes("config.allowlist_expires_at"));
});

test("an expiry that differs from the one passed fails even while inside the window", async () => {
  assert.deepEqual(
    await genesisFailures((s) => {
      s.config["allowlist_expires_at"] = BigInt(EXPECTED.allowlistExpiresAt + 86_400);
    }),
    ["config.allowlist_expires_at.passed"],
  );
});

test("every constructor address is compared with the one that was passed", async () => {
  for (const field of ["admin", "asset", "oracle", "fee_recipient"]) {
    assert.deepEqual(await genesisFailures((s) => (s.config[field] = "CWRONG")), [`config.${field}`], field);
  }
});

test("a half-finished admin handover at genesis fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["pending_admin"] = "GSOMEONE")), [
    "config.pending_admin",
  ]);
});

test("the deposit cap and its headroom are both checked", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["deposit_cap"] = 1n)), ["config.deposit_cap"]);
  assert.deepEqual(await genesisFailures((s) => (s.config["deposit_headroom"] = 1n)), [
    "config.deposit_headroom",
  ]);
});

test("the rent values step 3b produced are confirmed to have reached the constructor", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["rent_threshold"] = 99)), [
    "config.rent_threshold",
  ]);
  assert.deepEqual(await genesisFailures((s) => (s.config["rent_extend_to"] = 9_999)), [
    "config.rent_extend_to",
  ]);
});

test("an instance that is not at the genesis schema version fails", async () => {
  assert.deepEqual(await genesisFailures((s) => (s.config["app_version"] = 2)), ["config.app_version"]);
});

// =================================================================================================
// The assertion that closes the coherence gate
// =================================================================================================

test("a single wrong parameter is named, not reported as 'the objects differ'", async () => {
  // The realistic mistake: instance B's floor deployed under instance A's label.
  assert.deepEqual(
    await genesisFailures((s) => ((s.config["params"] as Record<string, unknown>)["premium_floor_bps"] = 20)),
    ["params.premium_floor_bps"],
  );
});

test("every one of the sixteen parameters is compared", async () => {
  for (const name of Object.keys(PARAMS)) {
    const ids = await genesisFailures((s) => {
      (s.config["params"] as Record<string, unknown>)[name] = 999_999;
    });
    assert.deepEqual(ids, [`params.${name}`], name);
  }
});

test("a parameter present on-chain but absent from the gated set is a failure, not a skip", () => {
  const onChain = { ...PARAMS, a_field_the_gate_never_saw: 1 };
  const checks = comparedParams(onChain, PARAMS);
  assert.deepEqual(failed(checks), ["params.a_field_the_gate_never_saw"]);
});

test("a parameter the expectation carries but the vault does not is a failure", () => {
  const onChain: Record<string, unknown> = { ...PARAMS };
  delete onChain["settle_bounty_bps"];
  assert.deepEqual(failed(comparedParams(onChain, PARAMS)), ["params.settle_bounty_bps"]);
});

test("an empty parameter set does not pass by having nothing to disagree about", () => {
  assert.deepEqual(failed(comparedParams({}, PARAMS)).length, Object.keys(PARAMS).length);
});

// =================================================================================================
// The Initialized event — the second, independent witness
// =================================================================================================

test("the constructor's own event agrees with the arguments that were passed", () => {
  assert.deepEqual(failed(verifyInitializedEvent([initializedEvent()], EXPECTED)), []);
});

test("a deploy transaction with no Initialized event fails, and says which events it saw", () => {
  const checks = verifyInitializedEvent([{ topics: ["mint"], data: {} }], EXPECTED);
  assert.deepEqual(failed(checks), ["event.initialized"]);
  assert.deepEqual(checks[0]?.actual, ["mint"]);
  // And it stops there rather than reporting thirteen field mismatches against an absent event.
  assert.equal(checks.length, 1);
});

test("an event that disagrees with storage is caught — that disagreement is a setter sequence", () => {
  assert.deepEqual(failed(verifyInitializedEvent([initializedEvent({ fee_bps: 30 })], EXPECTED)), [
    "event.initialized.fee_bps",
  ]);
  assert.deepEqual(failed(verifyInitializedEvent([initializedEvent({ token_suffix: "-B" })], EXPECTED)), [
    "event.initialized.token_suffix",
  ]);
  assert.deepEqual(
    failed(verifyInitializedEvent([initializedEvent({ allowlist_enabled: false })], EXPECTED)),
    ["event.initialized.allowlist_enabled"],
  );
});

// =================================================================================================
// The smoke round trip
// =================================================================================================

test("a first 1-XLM round trip loses exactly the dead-share floor and passes", async () => {
  const checks = await verifySmokeRoundTrip(new FakeChain(healthyState()), EXPECTED, SMOKE);
  assert.deepEqual(failed(checks), []);
  // The expectation is the sharpened one, not the old "exactly": D-36 charges the floor to the
  // first depositor and those shares can never come back out.
  const trip = checks.find((c) => c.id === "smoke.round_trip_exact")!;
  assert.equal(trip.expected, ONE_XLM - DEAD_SHARES);
  assert.equal(
    checks.find((c) => c.id === "smoke.total_assets_restored")!.expected,
    DEAD_SHARES,
    "zero would mean the floor was withdrawable",
  );
});

test("with no amount given, the deposit is the floor the vault is enforcing", async () => {
  // One XLM was hard-coded until 2026-08-24. It clears the fast-test profile's minimum exactly, so
  // it worked for every deploy that had ever run — and the first real-parameter deploy answered
  // `BelowMinDeposit`, because that profile asks ten. The floor is read from the vault now.
  const state = healthyState();
  const checks = await verifySmokeRoundTrip(new FakeChain(state), EXPECTED, {
    account: ADMIN,
    assetId: SAC,
  });
  const trip = checks.find((c) => c.id === "smoke.round_trip_exact")!;
  const floor = (state.config as { params: { min_deposit: number } }).params.min_deposit;
  assert.equal(trip.expected, BigInt(floor) - DEAD_SHARES);
});

test("a LATER deposit round-trips whole, because the floor is charged once", async () => {
  // The case the old battery could not tell apart, and the reason the script derives which it is
  // from the vault's own shares_outstanding rather than from a flag.
  const state = healthyState();
  state.epoch["shares_outstanding"] = 5n * ONE_XLM;
  state.totalAssets = 5n * ONE_XLM;
  const checks = await verifySmokeRoundTrip(new FakeChain(state), EXPECTED, SMOKE);
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.find((c) => c.id === "smoke.round_trip_exact")!.expected, ONE_XLM);
  assert.equal(checks.find((c) => c.id === "smoke.total_assets_restored")!.expected, 5n * ONE_XLM);
});

test("a one-stroop loss BEYOND the dead-share floor is still caught", async () => {
  // The sharpening must not have blunted it: a known exact loss is still an exact expectation.
  const chain = new FakeChain(healthyState(), { shortfall: 1n });
  assert.deepEqual(failed(await verifySmokeRoundTrip(chain, EXPECTED, SMOKE)), ["smoke.round_trip_exact"]);
});

test("a missing event on either half is caught", async () => {
  assert.deepEqual(
    failed(
      await verifySmokeRoundTrip(
        new FakeChain(healthyState(), { dropDepositEvent: "mint" }),
        EXPECTED,
        SMOKE,
      ),
    ),
    ["smoke.event.mint"],
  );
  assert.deepEqual(
    failed(
      await verifySmokeRoundTrip(
        new FakeChain(healthyState(), { dropWithdrawEvent: "withdraw_claimed" }),
        EXPECTED,
        SMOKE,
      ),
    ),
    ["smoke.event.withdraw_claimed"],
  );
});

test("an over-payment smaller than the dead-share floor is still caught", async () => {
  // Bounding against `before` instead of `before - DEAD_SHARES` would let this one through: the
  // floor leaves the account 1 000 stroops down, so a 5-stroop over-payment still lands below the
  // starting balance. The tighter bound is what makes it visible.
  const chain = new FakeChain(healthyState(), { balanceGain: 5n });
  assert.deepEqual(failed(await verifySmokeRoundTrip(chain, EXPECTED, SMOKE)), ["smoke.no_net_gain"]);
});

test("the withdraw is the instant-Idle path, asked for as such", async () => {
  const calls: unknown[][] = [];
  const base = new FakeChain(healthyState());
  const spy: ChainClient = {
    read: (c, m, a) => base.read(c, m, a),
    invoke: (c, m, a) => {
      calls.push([m, ...a]);
      return base.invoke(c, m, a);
    },
  };
  await verifySmokeRoundTrip(spy, EXPECTED, SMOKE);
  // `require_idle = true`: the contract refuses rather than queues if the phase moved. A queued
  // withdrawal paying later would satisfy a laxer assertion and prove nothing about the arithmetic.
  // The shares actually minted, not the amount deposited: D-36 took the floor out first.
  assert.deepEqual(calls[1], ["request_withdraw", ADMIN, ONE_XLM - DEAD_SHARES, true]);
});

test("the smoke test does not run — and nothing is signed — when a genesis assertion already failed", async () => {
  const state = healthyState();
  state.config["fee_bps"] = 30;
  const chain = new FakeChain(state);
  const result = await verifyDeployment(chain, EXPECTED, NOW, [initializedEvent({ fee_bps: 30 })], SMOKE);
  assert.equal(result.passed, false);
  assert.deepEqual(chain.invocations, [], "spent a transaction fee to learn nothing");
  assert.ok(result.checks.every((c) => !c.id.startsWith("smoke.")));
});

test("passing no smoke options runs the read-only half alone", async () => {
  const chain = new FakeChain(healthyState());
  const result = await verifyDeployment(chain, EXPECTED, NOW, [initializedEvent()], null);
  assert.equal(result.passed, true);
  assert.deepEqual(chain.invocations, []);
});

// =================================================================================================
// The decoding helpers — measured shapes, and the refusal to guess
// =================================================================================================

test("phaseName accepts the shape the SDK actually produces, and the bare string too", () => {
  assert.equal(phaseName(["Idle"]), "Idle");
  assert.equal(phaseName(["Auction"]), "Auction");
  assert.equal(phaseName("Active"), "Active");
});

test("phaseName refuses anything else rather than coercing it", () => {
  for (const bad of [["Settled"], "idle", 0, null, [], ["Idle", "Auction"], {}]) {
    assert.throws(() => phaseName(bad), /decoded as/, JSON.stringify(bad));
  }
});

test("sameValue compares a u32's number against a bigint expectation without a spurious failure", () => {
  assert.equal(sameValue(7, 7n), true);
  assert.equal(sameValue(7n, 7), true);
  assert.equal(sameValue(7n, 8), false);
  assert.equal(sameValue("7", 7n), false);
});

test("sameValue is structural over the decoded shapes", () => {
  assert.equal(sameValue({ a: 1n, b: [2, 3] }, { b: [2, 3], a: 1 }), true);
  assert.equal(sameValue({ a: 1n }, { a: 1n, b: 2n }), false);
  assert.equal(sameValue([1, 2], [1, 2, 3]), false);
  assert.equal(sameValue(null, undefined), false);
});

test("an event with no usable name is reported rather than crashing the battery", () => {
  assert.equal(observedEventName({ topics: [], data: {} }), null);
  assert.equal(observedEventName({ topics: [42], data: {} }), null);
  assert.deepEqual(
    eventNames([
      { topics: [], data: {} },
      { topics: ["mint"], data: {} },
    ]),
    ["(unnamed)", "mint"],
  );
});

// =================================================================================================
// Reporting
// =================================================================================================

test("a failure report carries both sides, so the operator does not go and look", async () => {
  const state = healthyState();
  state.config["fee_bps"] = 30;
  const result = await verifyDeployment(new FakeChain(state), EXPECTED, NOW, [initializedEvent()], null);
  const text = renderChecks(result, "-A").join("\n");
  assert.match(text, /FAIL.*config\.fee_bps/);
  assert.match(text, /expected 0/);
  assert.match(text, /actual {3}30/);
  assert.match(text, /assertions FAILED — the deploy is not verified/);
});

test("a passing report says how many assertions held", async () => {
  const result = await verifyDeployment(
    new FakeChain(healthyState()),
    EXPECTED,
    NOW,
    [initializedEvent()],
    SMOKE,
  );
  const text = renderChecks(result, "-A").join("\n");
  assert.match(text, /all \d+ assertions hold\./);
  assert.doesNotMatch(text, /FAIL/);
});
