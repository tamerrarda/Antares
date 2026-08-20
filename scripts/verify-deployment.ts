/**
 * verify-deployment.ts — `09-DEPLOYMENT.md` §2 **step 5**, the post-deploy verification battery.
 *
 * OWNER: DEV3 (`DEV-PROTOCOL.md` §3), Phase 6.
 *
 * WHAT THE STEP SAYS, and the four words that shape this file: *"Post-deploy verification (script
 * asserts, not eyeballs)"*. Everything below is a comparison the process performs and fails on. An
 * operator reading a terminal and nodding is not a check — it is a check-shaped memory of one.
 *
 * WHY IT IS WRITTEN BEFORE THE DEPLOY IT VERIFIES. `deploy.ts`'s other steps describe a happy path;
 * this one describes what the happy path is supposed to have produced. Written last, it becomes a
 * transcription of whatever the first deploy happened to do — which is a test that can never fail,
 * because it was derived from the output it is checking. Written first, it is the specification's
 * claims turned into comparisons before anything exists to bias them. `09-DEPLOYMENT.md` §2 step 5
 * and `DEV3.md` §6.1 are its single home; every assertion below cites the promise it enforces.
 *
 * THE PROMISES THIS TURNS INTO NUMBERS. Two of them are public and neither is checkable by reading
 * the source of a contract you did not compile: *"the fee ships at zero"* and *"the vault opens
 * within two weeks"*. `fee_bps == 0` and an `allowlist_expires_at` inside D-63's thirty-day window
 * are those sentences as things a stranger can verify against the deployed instance. The rest of
 * the battery exists so that reading them from a vault that had been quietly reconfigured is not
 * possible: §2 step 4 promises *"no post-deploy setter sequence — the contract is fully configured
 * when this transaction lands"*, and the only way to hold a deploy to that is to compare the live
 * configuration against the arguments the constructor was called with, field by field.
 *
 * **THE ASSERTION THAT CLOSES THE COHERENCE GATE.** Step 0b (`check-params.ts`) refuses the deploy
 * unless the *proposed* parameters clear five gates. Nothing in step 0b observes what step 4 then
 * passes to the constructor. If the two differ — an edited file, a wrong instance index, a stale
 * copy in a variable — the gate proved a property of a parameter set that is not the one running,
 * and it would have printed PASS while doing it. {@link verifyGenesis} compares `config().params`
 * against the exact set the gate judged, field by field, and that comparison is the only thing
 * anywhere that ties the two steps together.
 *
 * TWO INDEPENDENT READS OF THE SAME FACT. The constructor publishes `Initialized`, which carries
 * all ten arguments (`vault.rs` §2, `events.rs`). So the deploy transaction's own event stream is a
 * second witness to the configuration, arrived at through a different path than `config()` — one is
 * contract storage read back, the other is what the constructor said it was doing at the time.
 * {@link verifyInitializedEvent} checks them against each other. This is what makes step 6's
 * `deployments/<network>.json` a transcription of an on-chain fact rather than a claim about one.
 *
 * WHY THERE IS NO `main()` HERE. The smoke round-trip signs two transactions, so a standalone CLI
 * would need its own account handling — a second place where a key reaches a script, which
 * `07-SECURITY.md` §6 spends its length arguing against. `deploy.ts` already has exactly one such
 * path and this module borrows it through {@link ChainClient}. The port also makes every assertion
 * below testable without a network, which is `DEV-PROTOCOL.md` §6's requirement rather than a
 * convenience: a gate only ever exercised in the passing direction is a gate nobody has tested.
 *
 * DECODED-VALUE SHAPES ARE MEASURED, NOT ASSUMED (D-48/D-49). Every comparison here runs against
 * whatever `scValToNative` produces, and that mapping is an external fact. Measured against
 * `@stellar/stellar-sdk` on **2026-08-20**: `u32` → `number`, `u64` and `i128` → `bigint`, `bool` →
 * `boolean`, `String` → `string`, `Option::None` → `null`, a `#[contracttype]` struct → an object
 * with snake_case keys, and a unit-variant enum such as `Phase::Idle` → **`["Idle"]`, a
 * one-element array rather than the string `"Idle"`**. That last one is why {@link phaseName}
 * exists and why it accepts both forms: an equality test written against the shape a reader
 * expects would have failed on every healthy deploy.
 */

// =================================================================================================
// The port. Two methods, because step 5 needs to read state and to move a token.
// =================================================================================================

/** An event as it arrives from RPC after `scValToNative` — structurally `@antares/common`'s `RawEvent`. */
export interface ObservedEvent {
  /** The first topic is the event name: snake_case of the `#[contractevent]` struct (§10). */
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

export interface InvokeOutcome<T> {
  readonly value: T;
  readonly events: readonly ObservedEvent[];
  readonly txHash: string;
}

/**
 * The seam between the assertions and the network.
 *
 * `read` simulates and never signs; `invoke` signs and submits. They are separate methods rather
 * than one with a flag because the difference is *"this costs nothing and changes nothing"* versus
 * *"this spends a fee and moves a balance"*, and a boolean argument is how that distinction gets
 * lost at a call site.
 */
export interface ChainClient {
  read<T>(contractId: string, method: string, args?: readonly unknown[]): Promise<T>;
  invoke<T>(contractId: string, method: string, args: readonly unknown[]): Promise<InvokeOutcome<T>>;
}

// =================================================================================================
// Results
// =================================================================================================

export interface Check {
  /** Stable identifier, cited in the deployment record and in a failure report. */
  readonly id: string;
  /** The promise being enforced, in the words of the document that makes it. */
  readonly what: string;
  readonly ok: boolean;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly note?: string;
}

export class DeploymentVerificationError extends Error {
  readonly checks: readonly Check[];
  constructor(message: string, checks: readonly Check[]) {
    super(message);
    this.name = "DeploymentVerificationError";
    this.checks = checks;
  }
}

function check(
  id: string,
  what: string,
  expected: unknown,
  actual: unknown,
  ok: boolean,
  note?: string,
): Check {
  return note === undefined ? { id, what, ok, expected, actual } : { id, what, ok, expected, actual, note };
}

/** Structural equality over the decoded shapes — `bigint`, `number`, `string`, `boolean`, `null`, arrays, plain objects. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    // A `u32` field decodes as `number` and its expectation may be written as either; comparing a
    // 7 against a 7n with `===` is false, and that is a spurious failure rather than a finding.
    const na = typeof a === "bigint" || typeof a === "number" ? BigInt(a) : null;
    const nb = typeof b === "bigint" || typeof b === "number" ? BigInt(b) : null;
    return na !== null && nb !== null && na === nb;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

// =================================================================================================
// The decoded views, as `scValToNative` delivers them
// =================================================================================================

export const PHASES = ["Idle", "Auction", "Active"] as const;
export type PhaseName = (typeof PHASES)[number];

/**
 * The phase out of an `EpochInfo`, tolerant of both encodings the SDK has been seen to produce.
 *
 * Measured on 2026-08-20 as `["Idle"]`. Accepting the bare string as well is not defensive
 * clutter: the representation of a unit-variant enum is a property of the SDK version, this
 * repository pins that version with a caret, and the failure mode of getting it wrong is a gate
 * that refuses a healthy deploy. Anything else is rejected loudly rather than coerced.
 */
export function phaseName(raw: unknown): PhaseName {
  // `Array.isArray` narrows `unknown` to `any[]`, which would make the element an `any` and hand a
  // decoded value straight past the type system — the one thing this module must not do.
  const asArray: readonly unknown[] | null = Array.isArray(raw) ? (raw as readonly unknown[]) : null;
  const value: unknown = asArray !== null && asArray.length === 1 ? asArray[0] : raw;
  if (typeof value === "string" && (PHASES as readonly string[]).includes(value)) {
    return value as PhaseName;
  }
  throw new DeploymentVerificationError(
    `epoch().phase decoded as ${JSON.stringify(raw)}, which is neither "Idle" | "Auction" | ` +
      `"Active" nor a one-element array holding one. The decoded shape of a unit-variant enum is ` +
      `an @stellar/stellar-sdk fact, measured as ["Idle"] on 2026-08-20; if it has moved again, ` +
      `measure it and correct this function rather than widening the comparison until it passes.`,
    [],
  );
}

/** The subset of `EpochInfo` step 5 asserts on (`types.rs`). Other fields are read and reported. */
export interface EpochView {
  readonly round: number;
  readonly phase: unknown;
  readonly outcome_pending: boolean;
  readonly notional_offered: bigint;
  readonly notional_sold: bigint;
  readonly premium_collected: bigint;
  readonly locked_assets: bigint;
  readonly shares_outstanding: bigint;
  readonly last_pps: bigint;
  readonly last_finalize_time: bigint;
}

/** The subset of `ConfigView` step 5 asserts on (`types.rs`). */
export interface ConfigViewDecoded {
  readonly admin: string;
  readonly pending_admin: unknown;
  readonly asset: string;
  readonly oracle: string;
  readonly fee_recipient: string;
  readonly fee_bps: number;
  readonly deposit_cap: bigint;
  readonly deposit_headroom: bigint;
  readonly paused: boolean;
  readonly allowlist_enabled: boolean;
  readonly allowlist_expires_at: bigint;
  readonly app_version: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rent_threshold: number;
  readonly rent_extend_to: number;
}

// =================================================================================================
// Constants this battery compares against. Each is the contract's, restated only so a comparison
// can be written; the contract wins any disagreement and the fix is a corrected line here.
// =================================================================================================

/** `token.rs`: `DECIMALS`. Step 5 names 7 explicitly, so both documents have to agree with this. */
export const EXPECTED_DECIMALS = 7;

/** `token.rs`: `SYMBOL_BASE`. `symbol()` is this plus the suffix that was passed (D-52). */
export const SYMBOL_BASE = "aXLM";

/** `vault.rs`: `MAX_ALLOWLIST_WINDOW`, thirty days in seconds — D-63's cap, and step 5's window. */
export const MAX_ALLOWLIST_WINDOW = 2_592_000;

/** `types.rs`: `APP_VERSION` at genesis. `migrate` is monotonic from here (D-13). */
export const GENESIS_APP_VERSION = 1;

/** `types.rs`: `INITIAL_PPS = PRECISION`. 1e7, matching the asset's seven decimals. */
export const PRECISION = 10_000_000n;

/** One XLM in stroops — the smoke deposit's size, named because step 5 names it. */
export const ONE_XLM = 10_000_000n;

// =================================================================================================
// What the constructor was called with
// =================================================================================================

/**
 * The ten constructor arguments (D-56/D-63), as `deploy.ts` step 4 passed them.
 *
 * This is the expectation half of every comparison below. It is a parameter rather than something
 * re-read from `deployments/<network>.json`, because the record is written by step 6 *after* this
 * battery passes — verifying a deploy against a file the same deploy produced would compare a
 * value against itself.
 */
export interface GenesisExpectation {
  readonly vaultId: string;
  readonly admin: string;
  readonly asset: string;
  readonly oracle: string;
  readonly feeRecipient: string;
  /** `-A` … `-E`, or `""` for a lone deployment. `symbol()` is `aXLM` + this. */
  readonly tokenSuffix: string;
  readonly depositCap: bigint;
  readonly rentThreshold: number;
  readonly rentExtendTo: number;
  /** Unix seconds. */
  readonly allowlistExpiresAt: number;
  /**
   * The full `EpochParams` passed to the constructor — **and the exact set `check-params.ts`
   * judged**, which is the whole point of comparing it. Sixteen fields; the coherence gate reads
   * six of them.
   */
  readonly params: Readonly<Record<string, number | bigint>>;
}

// =================================================================================================
// Step 5, part 1 — the read-only battery
// =================================================================================================

/**
 * Every assertion step 5 makes that costs nothing and changes nothing.
 *
 * `nowSeconds` is a parameter rather than a call to the clock so the allowlist-window check can be
 * driven to both of its edges in a test. `09-DEPLOYMENT.md` §2 step 5 is the list; the additions
 * beyond its literal words are the genesis zeros and the constructor-argument comparison, and each
 * carries the reason it is here.
 */
export async function verifyGenesis(
  client: ChainClient,
  expected: GenesisExpectation,
  nowSeconds: number,
): Promise<Check[]> {
  const checks: Check[] = [];
  const vault = expected.vaultId;

  // ---- epoch(): Idle at round 0 ---------------------------------------------------------------
  const epoch = await client.read<EpochView>(vault, "epoch");
  checks.push(
    check(
      "epoch.round",
      "epoch() reports round 0 — nothing has been opened",
      0,
      epoch.round,
      epoch.round === 0,
    ),
  );
  const phase = phaseName(epoch.phase);
  checks.push(check("epoch.phase", "epoch() reports Idle", "Idle", phase, phase === "Idle"));

  // The zeros are not in step 5's sentence and they belong to it anyway. "Idle at round 0" is a
  // claim that nothing has happened yet; a vault reading Idle/0 while carrying shares outstanding
  // would satisfy the sentence and be a far worse object than one with the wrong phase. These are
  // the fields the constructor sets to zero (`vault.rs` §2), so any non-zero is either a deploy
  // against a used address or a constructor that did not run.
  const zeros: readonly (readonly [string, bigint])[] = [
    ["notional_offered", epoch.notional_offered],
    ["notional_sold", epoch.notional_sold],
    ["premium_collected", epoch.premium_collected],
    ["locked_assets", epoch.locked_assets],
    ["shares_outstanding", epoch.shares_outstanding],
    ["last_finalize_time", epoch.last_finalize_time],
  ];
  for (const [name, value] of zeros) {
    checks.push(
      check(
        `epoch.${name}`,
        `genesis state: ${name} is zero`,
        0n,
        value,
        value === 0n,
        "The constructor writes zero here; a non-zero means this is not a fresh instance.",
      ),
    );
  }
  checks.push(
    check(
      "epoch.outcome_pending",
      "no round is awaiting an outcome",
      false,
      epoch.outcome_pending,
      epoch.outcome_pending === false,
    ),
  );
  checks.push(
    check(
      "epoch.last_pps",
      "price per share starts at INITIAL_PPS",
      PRECISION,
      epoch.last_pps,
      epoch.last_pps === PRECISION,
      "`INITIAL_PPS = PRECISION` (types.rs). The first depositor mints at one share per unit.",
    ),
  );

  // ---- decimals(), symbol(), total_assets() ----------------------------------------------------
  const decimals = await client.read<number>(vault, "decimals");
  checks.push(
    check("token.decimals", "decimals() == 7", EXPECTED_DECIMALS, decimals, decimals === EXPECTED_DECIMALS),
  );

  const symbol = await client.read<string>(vault, "symbol");
  const wantSymbol = `${SYMBOL_BASE}${expected.tokenSuffix}`;
  checks.push(
    check(
      "token.symbol",
      "symbol() is aXLM plus the suffix that was passed",
      wantSymbol,
      symbol,
      symbol === wantSymbol,
      "D-52: five concurrent vaults issue five non-interchangeable tokens, and showing them all " +
        "as aXLM is a way for someone to believe they hold something they do not.",
    ),
  );

  const totalAssets = await client.read<bigint>(vault, "total_assets");
  checks.push(check("vault.total_assets", "total_assets() == 0", 0n, totalAssets, totalAssets === 0n));

  // ---- config(): the genesis constants, asserted rather than assumed ---------------------------
  const config = await client.read<ConfigViewDecoded>(vault, "config");

  checks.push(
    check(
      "config.fee_bps",
      'the public promise "the fee ships at zero", as a number a stranger can read',
      0,
      config.fee_bps,
      config.fee_bps === 0,
      "D-56 genesis constant. Moving it is a separate, publicly visible admin transaction.",
    ),
  );
  checks.push(
    check("config.paused", "the vault ships unpaused", false, config.paused, config.paused === false),
  );
  checks.push(
    check(
      "config.allowlist_enabled",
      "the allowlist is on at genesis",
      true,
      config.allowlist_enabled,
      config.allowlist_enabled === true,
    ),
  );

  // D-63's window, and it is bounded on *both* sides. The upper bound is the constructor's own cap
  // and step 5's sentence. The lower bound is not in either, and without it a vault could ship with
  // an expiry already in the past — which reads as `allowlist_enabled == true` while admitting
  // everyone, so the two checks above would pass and mean nothing.
  const expiresAt = Number(config.allowlist_expires_at);
  const horizon = nowSeconds + MAX_ALLOWLIST_WINDOW;
  checks.push(
    check(
      "config.allowlist_expires_at",
      'the public promise "the vault opens within two weeks", bounded on both sides',
      `${nowSeconds} < x <= ${horizon}`,
      expiresAt,
      expiresAt > nowSeconds && expiresAt <= horizon,
      "Upper bound is MAX_ALLOWLIST_WINDOW (D-63, capped at construction with no setter to move " +
        "it). Lower bound is this battery's: an already-expired allowlist is an open vault that " +
        "still reports allowlist_enabled == true.",
    ),
  );
  checks.push(
    check(
      "config.allowlist_expires_at.passed",
      "the expiry on-chain is the one step 4 passed",
      expected.allowlistExpiresAt,
      expiresAt,
      expiresAt === expected.allowlistExpiresAt,
    ),
  );

  // §2 step 4: "no post-deploy setter sequence — the contract is fully configured when this
  // transaction lands". Field by field is what holds a deploy to that.
  const addresses: readonly (readonly [string, string, string])[] = [
    ["admin", config.admin, expected.admin],
    ["asset", config.asset, expected.asset],
    ["oracle", config.oracle, expected.oracle],
    ["fee_recipient", config.fee_recipient, expected.feeRecipient],
  ];
  for (const [name, actual, want] of addresses) {
    checks.push(
      check(
        `config.${name}`,
        `${name} is the address the constructor was given`,
        want,
        actual,
        actual === want,
      ),
    );
  }
  checks.push(
    check(
      "config.pending_admin",
      "no admin handover is half-finished at genesis",
      null,
      config.pending_admin,
      config.pending_admin === null || config.pending_admin === undefined,
      "Option::None decodes as null (measured 2026-08-20).",
    ),
  );
  checks.push(
    check(
      "config.deposit_cap",
      "the cap is the one that was passed",
      expected.depositCap,
      config.deposit_cap,
      sameValue(config.deposit_cap, expected.depositCap),
    ),
  );
  checks.push(
    check(
      "config.deposit_headroom",
      "headroom equals the whole cap, because nothing is deposited",
      expected.depositCap,
      config.deposit_headroom,
      sameValue(config.deposit_headroom, expected.depositCap),
      "headroom = cap - (locked + pending); equal to the cap is the same fact as total_assets == 0, " +
        "reached through the other arithmetic.",
    ),
  );
  for (const [name, actual, want] of [
    ["rent_threshold", config.rent_threshold, expected.rentThreshold],
    ["rent_extend_to", config.rent_extend_to, expected.rentExtendTo],
  ] as const) {
    checks.push(
      check(
        `config.${name}`,
        `${name} is the value step 3b produced and step 4 passed`,
        want,
        actual,
        sameValue(actual, want),
        name === "rent_extend_to"
          ? "Step 3b asserts rent_extend_to <= the live max entry TTL. This is where that number " +
              "is confirmed to have reached the constructor."
          : undefined,
      ),
    );
  }
  checks.push(
    check(
      "config.app_version",
      "the instance is at the genesis schema version",
      GENESIS_APP_VERSION,
      config.app_version,
      config.app_version === GENESIS_APP_VERSION,
      "D-13: migrate is monotonic from here. A fresh deploy reading anything else means the wasm " +
        "is not the one this record claims.",
    ),
  );

  // ---- The assertion that closes the coherence gate --------------------------------------------
  checks.push(...comparedParams(config.params, expected.params));

  return checks;
}

/**
 * `config().params` against the set `check-params.ts` judged, field by field.
 *
 * Field by field rather than one deep comparison because the failure this hunts is *one* wrong
 * number — a `premium_floor_bps` from the instance above it in the table — and a single
 * `objects are not equal` tells the operator to go and diff two JSON blobs by eye. That is an
 * eyeball, which is the thing step 5 exists to remove.
 *
 * A field present on-chain and absent from the expectation is a failure, not a skip. The
 * expectation is meant to be the complete constructor argument; a missing key means the gate never
 * saw that parameter, and silently passing is how it stays unseen.
 */
export function comparedParams(
  onChain: Readonly<Record<string, unknown>>,
  expectedParams: Readonly<Record<string, number | bigint>>,
): Check[] {
  const checks: Check[] = [];
  const names = [...new Set([...Object.keys(onChain), ...Object.keys(expectedParams)])].sort();
  for (const name of names) {
    const has = Object.prototype.hasOwnProperty.call(expectedParams, name);
    const onChainHas = Object.prototype.hasOwnProperty.call(onChain, name);
    checks.push(
      check(
        `params.${name}`,
        `the deployed ${name} is the one the coherence gate judged`,
        has ? expectedParams[name] : "(absent from the gated set)",
        onChainHas ? onChain[name] : "(absent on-chain)",
        has && onChainHas && sameValue(onChain[name], expectedParams[name]),
        has && onChainHas
          ? undefined
          : "check-params.ts (step 0b) gates a parameter set; nothing in it observes what step 4 " +
              "then passes to the constructor. If the two differ, the gate proved a property of a " +
              "vault that is not running, and printed PASS while doing it.",
      ),
    );
  }
  return checks;
}

// =================================================================================================
// Step 5, part 2 — the constructor's own account of itself
// =================================================================================================

/** The name of an event: snake_case of the `#[contractevent]` struct, carried as the first topic. */
export function observedEventName(ev: ObservedEvent): string | null {
  const first = ev.topics[0];
  return typeof first === "string" && first !== "" ? first : null;
}

export function eventNames(events: readonly ObservedEvent[]): string[] {
  return events.map((e) => observedEventName(e) ?? "(unnamed)");
}

function eventField(ev: ObservedEvent, name: string): unknown {
  const data = ev.data;
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[name];
}

/**
 * The `Initialized` event from the deploy transaction, checked against the same expectation.
 *
 * A second witness reached by a different path: `config()` is storage read back, this is what the
 * constructor said it was doing while it ran. They can only disagree if something wrote to
 * configuration storage between the constructor and this battery — which is exactly the
 * "post-deploy setter sequence" §2 step 4 promises does not exist.
 *
 * It also makes step 6's record checkable by a stranger. `deployments/<network>.json` claims a set
 * of constructor arguments; this event is that claim's on-chain original, addressable by
 * transaction hash from the explorer link the record already carries.
 */
export function verifyInitializedEvent(
  events: readonly ObservedEvent[],
  expected: GenesisExpectation,
): Check[] {
  const checks: Check[] = [];
  const names = eventNames(events);
  const init = events.find((e) => observedEventName(e) === "initialized");
  checks.push(
    check(
      "event.initialized",
      "the deploy transaction published Initialized",
      "initialized",
      names,
      init !== undefined,
      "events.rs: the constructor's only event, carrying all ten arguments.",
    ),
  );
  if (init === undefined) return checks;

  const fields: readonly (readonly [string, unknown])[] = [
    ["admin", expected.admin],
    ["asset", expected.asset],
    ["oracle", expected.oracle],
    ["fee_recipient", expected.feeRecipient],
    ["token_suffix", expected.tokenSuffix],
    ["deposit_cap", expected.depositCap],
    ["rent_threshold", expected.rentThreshold],
    ["rent_extend_to", expected.rentExtendTo],
    ["allowlist_expires_at", expected.allowlistExpiresAt],
    ["fee_bps", 0],
    ["paused", false],
    ["allowlist_enabled", true],
    ["app_version", GENESIS_APP_VERSION],
  ];
  for (const [name, want] of fields) {
    const actual = eventField(init, name);
    checks.push(
      check(
        `event.initialized.${name}`,
        `Initialized.${name} agrees with the argument that was passed`,
        want,
        actual,
        sameValue(actual, want),
      ),
    );
  }
  return checks;
}

// =================================================================================================
// Step 5, part 3 — the smoke round trip
// =================================================================================================

/**
 * The events each half of the round trip must publish, from `vault.rs` and `token.rs`.
 *
 * Deposit into an Idle vault mints immediately, so `deposited` and `mint` both fire. The withdraw
 * is the instant-Idle path, which `vault.rs` documents as emitting **both** `withdraw_requested`
 * and `withdraw_claimed` in the same transaction — and at genesis only once, since the earlier
 * `WithdrawClaimed` is gated on `paid > 0 || claimed_round != 0` and both are zero when no round
 * has ever closed. `burn` accompanies the shares going away.
 *
 * The SAC's own `transfer` is deliberately *not* required. It is the asset contract's event, not
 * this vault's, and pinning a check to another contract's event vocabulary is how a healthy deploy
 * fails after somebody else's upgrade.
 */
export const DEPOSIT_EVENTS = ["deposited", "mint"] as const;
export const IDLE_WITHDRAW_EVENTS = ["withdraw_requested", "withdraw_claimed", "burn"] as const;

export interface SmokeOptions {
  /** The account performing the round trip — the deployer, already funded. */
  readonly account: string;
  /** The XLM SAC, for the balance comparison. */
  readonly assetId: string;
  /** Defaults to one XLM, which is the size step 5 names. */
  readonly amount?: bigint;
}

/**
 * A 1-XLM deposit and an instant Idle withdraw, asserted to round-trip **exactly**.
 *
 * "Exactly" is the load-bearing word in step 5's sentence and the reason this is worth two
 * signed transactions on every deploy. Assets go in, become shares at `INITIAL_PPS`, and come
 * back through the same arithmetic in the other direction; a rounding loss anywhere in that path
 * is a solvency bug that costs the first depositor and is invisible to every read-only check
 * above. One XLM is 1e7 stroops, which is large enough that a one-stroop truncation is a
 * detectable difference rather than a value below the smallest representable unit.
 *
 * The vault is left as it was found — same balance, zero total assets, zero shares — which is what
 * makes it safe to run against an instance that is about to be recorded as fresh.
 */
export async function verifySmokeRoundTrip(
  client: ChainClient,
  expected: GenesisExpectation,
  opts: SmokeOptions,
): Promise<Check[]> {
  const checks: Check[] = [];
  const vault = expected.vaultId;
  const amount = opts.amount ?? ONE_XLM;

  const balanceBefore = await client.read<bigint>(opts.assetId, "balance", [opts.account]);

  // ---- in ---------------------------------------------------------------------------------------
  const dep = await client.invoke<bigint>(vault, "deposit", [opts.account, amount]);
  const minted = dep.value;
  checks.push(
    check(
      "smoke.shares_minted",
      "an Idle deposit mints at INITIAL_PPS, so shares equal assets",
      amount,
      minted,
      minted === amount,
      `Not a general law — it holds because price per share is still ${PRECISION} at genesis, ` +
        "which epoch.last_pps above has already been asserted.",
    ),
  );
  const depNames = eventNames(dep.events);
  for (const name of DEPOSIT_EVENTS) {
    checks.push(
      check(`smoke.event.${name}`, `the deposit published ${name}`, name, depNames, depNames.includes(name)),
    );
  }
  const afterDeposit = await client.read<bigint>(vault, "total_assets");
  checks.push(
    check(
      "smoke.total_assets_after_deposit",
      "the deposit is visible in total_assets()",
      amount,
      afterDeposit,
      afterDeposit === amount,
    ),
  );

  // ---- and straight back out --------------------------------------------------------------------
  // `require_idle = true` is the point of the check rather than a convenience: it tells the
  // contract to refuse rather than to queue if the phase moved under us, so a pass here can only
  // mean the instant path ran. A queued withdrawal that pays later would satisfy a laxer assertion
  // and prove nothing about the arithmetic this is testing.
  const wd = await client.invoke<bigint>(vault, "request_withdraw", [opts.account, minted, true]);
  const paid = wd.value;
  checks.push(
    check(
      "smoke.round_trip_exact",
      "a 1-XLM deposit and an instant Idle withdraw round-trip exactly",
      amount,
      paid,
      paid === amount,
      "The word step 5 uses is 'exactly'. A one-stroop shortfall here is a rounding loss in the " +
        "share arithmetic, which is a solvency bug and is invisible to every read-only check.",
    ),
  );
  const wdNames = eventNames(wd.events);
  for (const name of IDLE_WITHDRAW_EVENTS) {
    checks.push(
      check(
        `smoke.event.${name}`,
        `the instant Idle withdraw published ${name}`,
        name,
        wdNames,
        wdNames.includes(name),
      ),
    );
  }

  // ---- and the vault is as it was found ---------------------------------------------------------
  const totalAfter = await client.read<bigint>(vault, "total_assets");
  checks.push(
    check("smoke.total_assets_restored", "total_assets() is zero again", 0n, totalAfter, totalAfter === 0n),
  );
  const epochAfter = await client.read<EpochView>(vault, "epoch");
  checks.push(
    check(
      "smoke.shares_outstanding_restored",
      "no shares are left outstanding",
      0n,
      epochAfter.shares_outstanding,
      epochAfter.shares_outstanding === 0n,
    ),
  );
  checks.push(
    check(
      "smoke.round_unchanged",
      "the round trip opened nothing",
      0,
      epochAfter.round,
      epochAfter.round === 0 && phaseName(epochAfter.phase) === "Idle",
    ),
  );

  // The account's balance is short by exactly the two transaction fees, which this module cannot
  // predict and deliberately does not try to. What it can assert is the direction and the bound:
  // the vault gave back everything it took, so the only shortfall is fees, and a balance that is
  // *higher* than it started means the vault paid out more than it received.
  const balanceAfter = await client.read<bigint>(opts.assetId, "balance", [opts.account]);
  checks.push(
    check(
      "smoke.no_net_gain",
      "the round trip did not pay the account more than it deposited",
      `<= ${balanceBefore}`,
      balanceAfter,
      balanceAfter <= balanceBefore,
      "Fees make the exact figure unpredictable, so this bounds the side that matters: a gain " +
        "would mean the vault paid out assets it never received.",
    ),
  );

  return checks;
}

// =================================================================================================
// Running the whole thing
// =================================================================================================

export interface StepFiveResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

/**
 * Step 5 end to end. `deployEvents` are the events of the deploy transaction itself, so that the
 * `Initialized` witness is available; pass an empty array when re-verifying an instance whose
 * deploy transaction is no longer to hand, and the missing-event check will say so rather than
 * pretend.
 */
export async function verifyDeployment(
  client: ChainClient,
  expected: GenesisExpectation,
  nowSeconds: number,
  deployEvents: readonly ObservedEvent[],
  smoke: SmokeOptions | null,
): Promise<StepFiveResult> {
  const checks: Check[] = [
    ...(await verifyGenesis(client, expected, nowSeconds)),
    ...verifyInitializedEvent(deployEvents, expected),
  ];
  // The smoke test runs last and only if everything above held. Signing two transactions against
  // an instance that has already failed a genesis assertion spends money to learn nothing.
  if (smoke !== null && checks.every((c) => c.ok)) {
    checks.push(...(await verifySmokeRoundTrip(client, expected, smoke)));
  }
  return { checks, passed: checks.every((c) => c.ok) };
}

function show(v: unknown): string {
  if (typeof v === "bigint") return `${v}`;
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? String(v);
}

/** One line per check, failures carrying both sides. Consumed by `deploy.ts`'s reporting. */
export function renderChecks(result: StepFiveResult, suffix: string): string[] {
  const lines: string[] = [`step 5 — post-deploy verification, instance ${suffix || "(none)"}`];
  for (const c of result.checks) {
    lines.push(`  [ ${c.ok ? "ok" : "FAIL"} ] ${c.id.padEnd(34)} ${c.what}`);
    if (!c.ok) {
      lines.push(`           expected ${show(c.expected)}`);
      lines.push(`           actual   ${show(c.actual)}`);
      if (c.note !== undefined) lines.push(`           ${c.note}`);
    }
  }
  const failed = result.checks.filter((c) => !c.ok).length;
  lines.push(
    result.passed
      ? `  all ${result.checks.length} assertions hold.`
      : `  ${failed} of ${result.checks.length} assertions FAILED — the deploy is not verified.`,
  );
  return lines;
}
