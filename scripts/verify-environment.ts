/**
 * verify-environment.ts — D-49's battery, run against a live network.
 *
 * OWNER: DEV2 (`DEV-PROTOCOL.md` §3). It sits under `scripts/`, which is otherwise DEV3's, and
 * **DEV1 reviews it** — nobody reviews their own file, and this one carries every oracle constant
 * the design rests on.
 *
 * WHY IT EXISTS (D-49). A whole adapter algorithm turned out to be unimplementable against the
 * real Reflector, and it was found by *querying* the contract rather than reading its
 * documentation (D-48). The rule that came out of that: any claim about an external system the
 * design depends on is checked against the live network and recorded with its measured value and
 * the date. Documented behaviour is a hypothesis; the response is the fact.
 *
 * THE BATTERY is `06-TEST-PLAN.md` §7b, which is its single home — read the *why* of each row
 * there, not from this file. This runs in Phase 1 and again as a deploy gate (09-DEPLOYMENT §2
 * step 0a).
 *
 * NETWORK VALUES ARE INPUTS, NEVER LITERALS. `06-TEST-PLAN.md` §8's TypeScript scope forbids a
 * hardcoded passphrase or contract address anywhere under `scripts/`, and exempts exactly
 * `packages/common/networks.ts` and `deployments/*.json` — the exemption is the point of the rule
 * rather than a hole in it.
 *
 * **`packages/common/networks.ts` has landed and this file now reads it** — the promise the previous
 * version of this comment made, and left outstanding for as long as the module took to arrive. A
 * promise nobody redeems is how a file drifts from what it says about itself.
 *
 * Redeeming it brought a property the environment version did not have. `resolveNetwork` honours
 * `RPC_URL` and **refuses a `NETWORK_PASSPHRASE` override**, deliberately: pointing at a different
 * RPC for the same network is ordinary operations, while a passphrase override means describing one
 * network and talking to another. This script signs nothing, so it cannot produce a signature for
 * the wrong chain — but it *can* measure one network and write the other's name into a committed
 * record, and `deployments/environment-testnet.json` is a file people are meant to recompute from.
 *
 * IT SIGNS NOTHING. Every call is a read-only `simulateTransaction`, so no secret key is involved
 * and no CI secret is needed. A source account is required only because a simulation must be
 * built against one; it is funded from friendbot at run time and thrown away.
 */

import {
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { resolveNetwork, resolveRpcUrl } from '@antares/common/networks';

// ---------------------------------------------------------------------------------------------
// Constants that are *the design's*, restated here only so the gate can be computed. Each names
// the document that owns it; if one of these disagrees with its document, the document wins.
// ---------------------------------------------------------------------------------------------

/**
 * The feed's reachable depth, in ticks — the number `R = CAP × resolution()` is derived from
 * (`04-ORACLE.md` §2 rule 3, D-64 as corrected by D-69). This is the single value the
 * reachable-depth gate tests, and it is deliberately one named constant: changing it is a change
 * to an on-chain constant and must arrive as a reviewed edit to `04-ORACLE.md` first, never as a
 * tweak here to make the gate pass.
 *
 * It was `256` until this script measured the live feed on 2026-08-19 and the gate fired. The
 * bitmask holds **256 records, which span 255 intervals**, and `R` is a depth — so the correct
 * multiplier is 255. That off-by-one sat on the side that costs money: the adapter's oldest guard
 * sample would have landed one tick beyond the horizon and a healthy feed would have produced
 * `Unusable`, which is the void path. The sequence that produced this line is the one D-49 asks
 * for: measure, file the finding (D-69), fix the documents, then change the code.
 */
const RECORD_CAP_TICKS = 255;

/** The UI's live-window assumption, in seconds (`06-TEST-PLAN.md` §7b, DEV3's Claims page). */
const UI_LIVE_WINDOW_SECONDS = 7 * 24 * 3600;

/** The protocol version the deployed wasm is built against — `soroban-sdk =27.0.6`, D-23. */
const EXPECTED_PROTOCOL_VERSION = 27;

/**
 * The shipped testnet/mainnet parameter table, instance A (`02-CONTRACT-SPEC.md` §1). Used only
 * to report the admissible intervals the live `resolution()` implies; this file never proposes
 * parameters, it reports whether the shipped ones remain writable.
 */
const SHIPPED = {
  epoch_duration: 604_800,
  twap_window: 900,
  guard_window: 3_600,
  oracle_dead_after: 43_200,
  settle_grace: 7_200,
  unresolved_after: 75_600,
} as const;

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'INFO';

interface Check {
  readonly id: string;
  readonly what: string;
  readonly status: Status;
  readonly measured: unknown;
  readonly note?: string;
}

const checks: Check[] = [];

function record(id: string, what: string, status: Status, measured: unknown, note?: string): void {
  const c: Check = note === undefined ? { id, what, status, measured } : { id, what, status, measured, note };
  checks.push(c);
  const mark = status === 'PASS' ? '  ok  ' : status === 'FAIL' ? ' FAIL ' : ' info ';
  console.log(`[${mark}] ${id.padEnd(6)} ${what}`);
  console.log(`         ${fmt(measured)}`);
  if (note !== undefined) for (const line of wrap(note, 92)) console.log(`         ${line}`);
}

function fmt(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

function hms(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${seconds} s = ${h} h ${String(m).padStart(2, '0')} m`;
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

interface Env {
  readonly network: string;
  readonly rpcUrl: string;
  readonly passphrase: string;
  readonly reflectorId: string;
  readonly assetSymbol: string;
  readonly sourceAccount: string | undefined;
  readonly full: boolean;
  readonly jsonOut: string | undefined;
  /** A prior `--full` record to union this sweep with (06-TEST-PLAN §7b). */
  readonly unionWith: string | undefined;
}

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    console.error(
      `\nMissing required environment variable ${name}.\n\n` +
        `Network values are inputs to this script, never literals in it — 06-TEST-PLAN §8's\n` +
        `TypeScript scope forbids a hardcoded passphrase or contract address under scripts/.\n` +
        `Required: NETWORK, RPC_URL, NETWORK_PASSPHRASE, REFLECTOR_ID.\n` +
        `Optional: ASSET_SYMBOL (default XLM), SOURCE_ACCOUNT (a funded G... public key;\n` +
        `          omitted, a throwaway account is created from friendbot).\n`,
    );
    process.exit(2);
  }
  return v.trim();
}

function readEnv(argv: readonly string[]): Env {
  const jsonIdx = argv.indexOf('--json');
  // `networks.ts` is the single home for every network value (08-OFFCHAIN §1). `NETWORK` selects,
  // `RPC_URL` may override the endpoint, and the passphrase is **not** overridable — see the header.
  const net = resolveNetwork(process.env);
  return {
    network: net.name,
    rpcUrl: resolveRpcUrl(net, process.env),
    passphrase: net.networkPassphrase,
    reflectorId: need('REFLECTOR_ID'),
    assetSymbol: process.env['ASSET_SYMBOL']?.trim() ?? 'XLM',
    sourceAccount: process.env['SOURCE_ACCOUNT']?.trim() || undefined,
    full: argv.includes('--full'),
    jsonOut: jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined,
    unionWith: (() => {
      const i = argv.indexOf('--union-with');
      return i >= 0 ? argv[i + 1] : undefined;
    })(),
  };
}

// ---------------------------------------------------------------------------------------------
// The oracle client — simulation only
// ---------------------------------------------------------------------------------------------

interface CallResult {
  readonly value: unknown;
  readonly error?: string;
  /** Resource fee in stroops, as the network prices this call today. */
  readonly fee: number;
  /** CPU instructions the simulation reports. */
  readonly cpu: number;
  /** Ledger bytes read. */
  readonly readBytes: number;
}

// Plain fields rather than TypeScript parameter properties: this file runs under
// `node --experimental-strip-types`, which erases annotations and refuses any syntax that would
// need code generation. Keeping it strip-only means the script has no transpiler in its path —
// one less thing between a measured number and the person reading it.
class Oracle {
  readonly #server: rpc.Server;
  readonly #contract: Contract;
  readonly #source: Awaited<ReturnType<rpc.Server['getAccount']>>;
  readonly #passphrase: string;
  /** `Asset::Other(SYMBOL)` — verified live to be the XLM variant, never `Asset::Stellar` (D-48). */
  readonly asset: xdr.ScVal;

  private constructor(
    server: rpc.Server,
    contract: Contract,
    source: Awaited<ReturnType<rpc.Server['getAccount']>>,
    passphrase: string,
    asset: xdr.ScVal,
  ) {
    this.#server = server;
    this.#contract = contract;
    this.#source = source;
    this.#passphrase = passphrase;
    this.asset = asset;
  }

  static async connect(env: Env, friendbotUrl: string | undefined): Promise<Oracle> {
    const server = new rpc.Server(env.rpcUrl);
    let pubkey = env.sourceAccount;
    if (pubkey === undefined) {
      if (friendbotUrl === undefined) {
        console.error(
          '\nNo SOURCE_ACCOUNT given and the network advertises no friendbot.\n' +
            'A simulation must be built against an existing account. Pass SOURCE_ACCOUNT=G...\n',
        );
        process.exit(2);
      }
      const kp = Keypair.random();
      const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`);
      if (!res.ok) {
        console.error(`\nfriendbot funding failed (${res.status}). Pass SOURCE_ACCOUNT=G... instead.\n`);
        process.exit(2);
      }
      pubkey = kp.publicKey();
    }
    const account = await server.getAccount(pubkey);
    const asset = xdr.ScVal.scvVec([
      nativeToScVal('Other', { type: 'symbol' }),
      nativeToScVal(env.assetSymbol, { type: 'symbol' }),
    ]);
    return new Oracle(server, new Contract(env.reflectorId), account, env.passphrase, asset);
  }

  async call(fn: string, ...args: xdr.ScVal[]): Promise<CallResult> {
    const tx = new TransactionBuilder(this.#source, { fee: '10000000', networkPassphrase: this.#passphrase })
      .addOperation(this.#contract.call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.#server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { value: null, error: sim.error, fee: 0, cpu: 0, readBytes: 0 };
    }
    const resources = sim.transactionData?.build().resources();
    return {
      value: sim.result === undefined ? null : scValToNative(sim.result.retval),
      fee: Number(sim.minResourceFee ?? 0),
      cpu: Number(resources?.instructions() ?? 0),
      readBytes: Number(resources?.diskReadBytes() ?? 0),
    };
  }

  /** `price(asset, t)` — returns null both for "no record" and for "beyond the cap". */
  async priceAt(t: number): Promise<{ answered: boolean; cost: CallResult }> {
    const r = await this.call('price', this.asset, nativeToScVal(t, { type: 'u64' }));
    return { answered: r.error === undefined && r.value !== null, cost: r };
  }
}

/** Run `jobs` with bounded concurrency — the RPC is a shared public endpoint, not ours to flood. */
async function pooled<T, R>(items: readonly T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readEnv(process.argv.slice(2));
  const started = new Date().toISOString();

  console.log('');
  console.log(`Antares — environment verification (D-49)   ${started}`);
  console.log(`network ${env.network}   rpc ${env.rpcUrl}`);
  console.log(`oracle  ${env.reflectorId}   asset Other("${env.assetSymbol}")`);
  console.log(`mode    ${env.full ? '--full (sweeps the whole reachable depth)' : '--quick (bisects; use --full for the sweep)'}`);
  console.log('');

  // -- E-1  RPC health and the ledger retention window ------------------------------------------
  const server = new rpc.Server(env.rpcUrl);
  // `getHealth` returns oldest/latest ledger close times — measured present on Stellar RPC 28.0.0,
  // 2026-08-19 — but the SDK's `GetHealthResponse` does not declare them. The cast is narrow and
  // named rather than an `any`, and the fields are treated as optional so a server that omits
  // them degrades to the ledger count instead of reporting a nonsense span.
  interface HealthCloseTimes {
    readonly oldestLedgerCloseTime?: string | number;
    readonly latestLedgerCloseTime?: string | number;
  }
  const health = await server.getHealth();
  const closeTimes = health as unknown as HealthCloseTimes;
  const network = await server.getNetwork();
  const latest = await server.getLatestLedger();
  const retentionLedgers = Number(health.ledgerRetentionWindow ?? 0);
  // The window is expressed in ledgers; the wall-clock span is what the UI actually assumes.
  const oldestClose = Number(closeTimes.oldestLedgerCloseTime ?? 0);
  const latestClose = Number(closeTimes.latestLedgerCloseTime ?? latest.closeTime ?? 0);
  const retentionSeconds = oldestClose > 0 ? latestClose - oldestClose : 0;
  record(
    'E-1',
    'RPC ledgerRetentionWindow covers the UI live-window assumption',
    retentionSeconds >= UI_LIVE_WINDOW_SECONDS ? 'PASS' : 'FAIL',
    `${retentionLedgers} ledgers spanning ${hms(retentionSeconds)}; assumption ${hms(UI_LIVE_WINDOW_SECONDS)}`,
    'Events vanish past this window; anything older must come from views or the archive. DEV3\'s Claims page rests on it.',
  );

  // -- E-2  Protocol version vs the SDK the wasm is built against --------------------------------
  const protocolVersion = Number(network.protocolVersion ?? latest.protocolVersion ?? 0);
  record(
    'E-2',
    'network protocolVersion matches the SDK the wasm was built against',
    protocolVersion === EXPECTED_PROTOCOL_VERSION ? 'PASS' : 'FAIL',
    `live ${protocolVersion}; expected ${EXPECTED_PROTOCOL_VERSION} (soroban-sdk =27.0.6, D-23)`,
  );

  const oracle = await Oracle.connect(env, network.friendbotUrl ?? undefined);

  // -- E-3  Feed identity (D-30) ------------------------------------------------------------------
  const base = await oracle.call('base');
  const assets = await oracle.call('assets');
  const assetList = Array.isArray(assets.value) ? (assets.value as unknown[]) : [];
  const carriesAsset = assetList.some(
    (a) => Array.isArray(a) && a[0] === 'Other' && a[1] === env.assetSymbol,
  );
  record(
    'E-3',
    `feed identity: base asset, and the asset list carries Other("${env.assetSymbol}")`,
    carriesAsset ? 'PASS' : 'FAIL',
    `base = ${fmt(base.value)}; ${assetList.length} assets; carries ${env.assetSymbol}: ${carriesAsset}`,
    'D-30: the pinned feed MUST be the external CEX & DEX feed, never an SDEX-sourced one. On-chain data proves the base ' +
      'asset and the asset list; that this contract id is the CEX & DEX feed is a fact about which address was pinned, ' +
      'and is asserted against the deployment record, not derivable from here.',
  );

  // -- E-4  resolution / decimals / retention / version -------------------------------------------
  const resolution = Number((await oracle.call('resolution')).value);
  const decimals = Number((await oracle.call('decimals')).value);
  const lastTimestamp = Number((await oracle.call('last_timestamp')).value);
  const retentionPeriod = Number((await oracle.call('history_retention_period')).value ?? 0);
  const version = (await oracle.call('version')).value;
  record(
    'E-4',
    'resolution(), decimals(), history_retention_period(), version()',
    resolution > 0 && decimals > 0 ? 'PASS' : 'FAIL',
    `resolution = ${resolution} s; decimals = ${decimals}; advertised retention = ${hms(retentionPeriod)}; version = ${fmt(version)}`,
    'decimals is configuration, not a constant — the adapter normalizes against the live value and pins it per round (D-68).',
  );

  // -- E-5  The unit assertion (added 2026-08-19) --------------------------------------------------
  // Every derivation in the design reads `resolution() = 300` as SECONDS. In milliseconds the
  // feed-internal arithmetic stays self-consistent while the vault's durations are ledger
  // seconds, so supports_round's conditions come out wrong by 1000x inside an on-chain constant
  // and nothing else in this battery would notice.
  const clockSkew = Math.abs(lastTimestamp - latestClose);
  const unitsLookLikeSeconds = clockSkew < 86_400 && resolution < 86_400;
  record(
    'E-5',
    'the unit of resolution() and of PriceData.timestamp is SECONDS, asserted rather than assumed',
    unitsLookLikeSeconds ? 'PASS' : 'FAIL',
    `last_timestamp = ${lastTimestamp}; ledger closeTime = ${latestClose}; |difference| = ${clockSkew} s; resolution = ${resolution}`,
    'A millisecond feed would put last_timestamp about 1000x above the ledger clock. This is D-49 applied to the one ' +
      'value every other row takes for granted.',
  );

  // -- E-6  Reachable depth, and E-7 tick completeness ----------------------------------------------
  // The feed serves price(asset, t) while floor((last_timestamp - t) / res) <= 255. Depth is
  // therefore measured from last_timestamp, which is the quantity the contract itself compares
  // against — not from `now`. The adapter takes the more conservative of the two at run time
  // (`horizon = max(now, last_timestamp())`, 04-ORACLE §2 rule 3 / D-69) because the feed can sit
  // on either side of the ledger clock; here we are measuring the feed's own cap, so
  // last_timestamp is the right and only reference.
  const probe = async (k: number): Promise<boolean> => (await oracle.priceAt(lastTimestamp - k * resolution)).answered;

  let deepestAnswering: number;
  let gaps: number[] = [];
  let sweepPoints = 0;

  if (env.full) {
    // The sweep IS the measurement (06-TEST-PLAN §7b, corrected 2026-08-19). Binary search assumes
    // the answers/does-not-answer predicate is monotone in depth, and the completeness measurement
    // exists precisely because it may not be: a gap inside the window makes a bisection converge on
    // the gap rather than on the cap.
    const horizon = RECORD_CAP_TICKS + 12;
    const ks = Array.from({ length: horizon + 1 }, (_v, i) => i);
    const answered = await pooled(ks, 8, probe);
    sweepPoints = ks.length;
    deepestAnswering = answered.lastIndexOf(true);
    for (let k = 0; k <= deepestAnswering; k++) if (answered[k] !== true) gaps.push(k);
  } else {
    // Bisection, the cheap form the deploy gate runs. Reported as a cross-check, never alone.
    let lo = 0;
    let hi = RECORD_CAP_TICKS + 12;
    if (!(await probe(lo))) {
      deepestAnswering = -1;
    } else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await probe(mid)) lo = mid;
        else hi = mid;
      }
      deepestAnswering = lo;
    }
  }

  // -- The shortfall is confirmed before it fails, and the reason is not tolerance ----------------
  //
  // **This measurement has a race the contract does not have.** The feed's cap is defined against
  // `last_timestamp`: it serves `price(t)` while `floor((last_timestamp - t) / res) <= 255`. This
  // script reads `last_timestamp` once, in E-4, and then probes for as long as the sweep takes —
  // measured at **13.1 s** for `--full`'s 268 points at concurrency 8. If the feed ticks inside
  // that window, every depth computed from the old `last_timestamp` is one tick deeper against the
  // new one, and the deepest probe answers `None` **on a feed that is exactly as deep as it should
  // be**. At a 300 s tick that is a ~4.4 % chance per run — one in 23, and the observed shortfall
  // rate is one in eighteen pooled across two developers.
  //
  // `reflector-adapter` cannot hit this. It reads `live_last_timestamp()` and calls `out_of_reach`
  // **inside one invocation**, so both sides of the comparison come from the same ledger and
  // `last_timestamp` cannot move between them. Zero margin is exact there; it is only a race here.
  //
  // So a shortfall re-measures against a freshly read `last_timestamp` before it is allowed to
  // fail. This is not a retry that hides a failure — a genuine shortfall reproduces, and the
  // re-measurement reports both readings so the distribution accumulates with use rather than
  // needing its own campaign.
  let confirmedAt = lastTimestamp;
  let confirmedDeepest = deepestAnswering;
  let raced = false;
  if (deepestAnswering < RECORD_CAP_TICKS) {
    const fresh = Number((await oracle.call('last_timestamp')).value);
    if (Number.isFinite(fresh) && fresh !== lastTimestamp) raced = true;
    confirmedAt = fresh;
    let lo = 0;
    let hi = RECORD_CAP_TICKS + 12;
    const reprobe = async (k: number): Promise<boolean> =>
      (await oracle.priceAt(fresh - k * resolution)).answered;
    if (!(await reprobe(lo))) {
      confirmedDeepest = -1;
    } else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await reprobe(mid)) lo = mid;
        else hi = mid;
      }
      confirmedDeepest = lo;
    }
  }

  const cutoffSeconds = confirmedDeepest * resolution;
  const requiredSeconds = RECORD_CAP_TICKS * resolution;
  record(
    'E-6',
    `reachable-depth cutoff, to one tick, is >= ${RECORD_CAP_TICKS} x resolution()`,
    cutoffSeconds >= requiredSeconds ? 'PASS' : 'FAIL',
    `deepest answering tick = ${confirmedDeepest} -> ${hms(cutoffSeconds)} from last_timestamp; ` +
      `required ${RECORD_CAP_TICKS} ticks = ${hms(requiredSeconds)}` +
      (confirmedDeepest === deepestAnswering && !raced
        ? ''
        : `; first reading ${deepestAnswering} at last_timestamp ${lastTimestamp}, re-measured ` +
          `${confirmedDeepest} at ${confirmedAt}${raced ? ' — the feed ticked mid-sweep, which is this script\'s race and not the contract\'s' : ''}`),
    'A shortfall is not a documentation nit. reach_limit = R - guard_window is derived from R = CAP x res, so if the ' +
      'true cutoff sits below R the adapter reaches past its own horizon: the oldest guard sample returns None, the ' +
      'valid count falls under 04-ORACLE §2 rule 2, and a HEALTHY feed produces Unusable — which is the void path.',
  );

  if (env.full) {
    const reachable = deepestAnswering + 1;
    const completeness = reachable > 0 ? (reachable - gaps.length) / reachable : 0;
    record(
      'E-7',
      'tick completeness across the feed\'s reachable depth',
      gaps.length === 0 ? 'PASS' : 'INFO',
      `${(completeness * 100).toFixed(2)} % over ${reachable} grid points (${sweepPoints} probed); ` +
        `${gaps.length} gap(s)${gaps.length > 0 ? ` at ticks ${JSON.stringify(gaps.slice(0, 24))}` : ''}`,
      'D-65 requires all 3 short samples, so a single gap now voids a round that used to settle. The window is the ' +
        'reachable depth and not "24 h": a point query older than the cap returns None BY THE CAP, not by a gap, so a ' +
        'retrospective 24-hour sweep would score its oldest stretch as 100 % missing. Run this twice, >= 3 h apart, and ' +
        'report the union for coverage beyond one depth.',
    );
  }

  // -- E-8  The seven-point battery's cost, and its constancy in the anchor's age -------------------
  // The adapter does not exist in Phase 1, and Soroban admits one InvokeHostFunction per
  // transaction, so seven price() calls are seven simulations rather than one budget. What is
  // measured here is per-call cost, its sum as a LOWER BOUND on the real read, and — the half
  // D-64's residual actually rests on — that the cost does not vary with the anchor's age.
  const shortStep = Math.max(resolution, Math.floor(SHIPPED.twap_window / 2 / resolution) * resolution);
  const guardStep = Math.max(resolution, Math.floor(SHIPPED.guard_window / 4 / resolution) * resolution);
  const offsets = [0, shortStep, 2 * shortStep, guardStep, 2 * guardStep, 3 * guardStep, 4 * guardStep];
  const distinctOffsets = [...new Set(offsets)];

  const ageTicks = [1, 24, 96, 168, Math.max(0, deepestAnswering - Math.ceil(SHIPPED.guard_window / resolution) - 1)]
    .filter((k) => k > 0 && k <= deepestAnswering);

  const perAge: { ageSeconds: number; totalCpu: number; totalFee: number; maxCpu: number }[] = [];
  for (const k of ageTicks) {
    const end = lastTimestamp - k * resolution;
    const results = await pooled(distinctOffsets, 4, async (off) => (await oracle.priceAt(end - off)).cost);
    perAge.push({
      ageSeconds: k * resolution,
      totalCpu: results.reduce((a, r) => a + r.cpu, 0),
      totalFee: results.reduce((a, r) => a + r.fee, 0),
      maxCpu: Math.max(...results.map((r) => r.cpu)),
    });
  }
  const cpus = perAge.map((p) => p.totalCpu);
  const spread = cpus.length > 1 ? Math.max(...cpus) - Math.min(...cpus) : 0;
  const spreadPct = cpus.length > 1 && Math.min(...cpus) > 0 ? (spread / Math.min(...cpus)) * 100 : 0;
  record(
    'E-8',
    'seven-point battery cost, and that it does NOT vary with the anchor\'s age',
    spreadPct < 5 ? 'PASS' : 'FAIL',
    perAge
      .map((p) => `age ${hms(p.ageSeconds)} -> ${p.totalCpu} CPU insn, ${p.totalFee} stroops`)
      .join('; ') + `  | spread ${spreadPct.toFixed(2)} %`,
    'D-64\'s residual rests entirely on this constancy: budget exhaustion is then a never-worked-at-all failure rather ' +
      'than a latent time bomb. Phase 1 measures per-call cost and their sum as a LOWER BOUND — the authoritative ' +
      'aggregate is Phase 3\'s resource profile against the real adapter (DEV2.md §3.2).',
  );

  // -- E-9  prices() collapse point (D-48) -----------------------------------------------------------
  let pricesCollapse = 0;
  for (const n of [1, 5, 10, 15, 20, 21, 22, 23, 24, 32, 48, 64]) {
    const r = await oracle.call('prices', oracle.asset, nativeToScVal(n, { type: 'u32' }));
    if (r.error !== undefined || r.value === null) break;
    pricesCollapse = n;
  }
  record(
    'E-9',
    'the batch prices() call\'s collapse point',
    'INFO',
    `largest answering records = ${pricesCollapse}`,
    'D-48: the adapter uses point queries on a derived grid, never this call, because the batch blows its own resource ' +
      'budget long before the retention window. Recorded so the reason stays measured rather than remembered.',
  );

  // -- E-10  Feed sponsorship (condition 7) -----------------------------------------------------------
  const expiresRaw = (await oracle.call('expires', oracle.asset)).value;
  const expires = expiresRaw === null ? null : Number(expiresRaw);
  const roundSpan = SHIPPED.epoch_duration + SHIPPED.unresolved_after;
  const runway = expires === null ? -1 : expires - latestClose;
  record(
    'E-10',
    'feed expires() outlives epoch_duration + unresolved_after (supports_round condition 7)',
    expires !== null && runway > roundSpan ? 'PASS' : 'FAIL',
    expires === null
      ? 'expires() = None — the feed is unsponsored, and condition 7 treats a None expiry as false'
      : `expires = ${expires} -> runway ${hms(runway)}; round_span ${hms(roundSpan)}`,
    'Sponsored feeds die on a schedule (04-ORACLE §5). This is the exact span condition 7 enforces on-chain; the older ' +
      '"+ oracle_dead_after" form was weaker than the gate, so a deploy passed and the first open_epoch refused.',
  );

  // -- E-11  What the live resolution() implies for the shipped table --------------------------------
  const R = RECORD_CAP_TICKS * resolution;
  const reachLimit = R - SHIPPED.guard_window;
  const uaLow = reachLimit; // condition 3 is STRICT: unresolved_after > reach_limit
  const uaHigh = reachLimit + SHIPPED.settle_grace; // condition 6 is a ceiling, inclusive
  const uaOk = SHIPPED.unresolved_after > uaLow && SHIPPED.unresolved_after <= uaHigh;
  // The res band, with the shipped table held fixed: conditions 1, 3, 4 and 6 jointly.
  const resLow = Math.max(
    Math.ceil((SHIPPED.unresolved_after + SHIPPED.guard_window - SHIPPED.settle_grace) / RECORD_CAP_TICKS), // cond 6
    Math.floor((SHIPPED.oracle_dead_after + SHIPPED.guard_window + SHIPPED.settle_grace) / RECORD_CAP_TICKS) + 1, // cond 4
  );
  const resHighCap = Math.ceil((SHIPPED.unresolved_after + SHIPPED.guard_window) / RECORD_CAP_TICKS) - 1; // cond 3
  const resHigh = Math.min(resHighCap, Math.floor(SHIPPED.twap_window / 2), Math.floor(SHIPPED.guard_window / 4));
  record(
    'E-11',
    'the live resolution() and the admissible unresolved_after interval it implies',
    uaOk ? 'PASS' : 'FAIL',
    `R = ${RECORD_CAP_TICKS} x ${resolution} = ${hms(R)}; reach_limit = ${hms(reachLimit)}; ` +
      `admissible unresolved_after = (${uaLow}, ${uaHigh}]; shipped ${SHIPPED.unresolved_after} -> ${uaOk ? 'inside' : 'OUTSIDE'}; ` +
      `admissible resolution for the shipped table = [${resLow}, ${resHigh}]`,
    'With the shipped table fixed, conditions 1/3/4/6 are jointly satisfiable only inside that resolution band (D-68). A ' +
      'tick change outside it makes the shipped parameters unwritable through set_epoch_params until unresolved_after is ' +
      'lowered — a running vault keeps closing on its snapshot, but the next open_epoch fails. Recorded so the margin is ' +
      'visible before a deploy rather than discovered by a rejected open.',
  );

  // -- E-12  The union of two sweeps, which is what >24 h of coverage actually means ---------------
  // A single sweep can only ever see the reachable depth (~21 h 15 m), so ">= 24 h" is reached by
  // sweeping twice and unioning, never by asking one call to see past the cap. The union is
  // computed here rather than asserted in prose, so a deploy can reproduce it.
  let union: {
    spanSeconds: number;
    points: number;
    gaps: number;
    completeness: number;
    runs: { at: number; ticks: number }[];
  } | null = null;

  if (env.full && env.unionWith !== undefined) {
    const { readFileSync } = await import('node:fs');
    const prior = JSON.parse(readFileSync(env.unionWith, 'utf8')) as {
      oracle: { lastTimestamp: number; resolution: number };
      measurements: { reachableDepthTicks: number; tickCompletenessGaps: number[] | null };
    };
    // Absolute timestamps, because the two sweeps are anchored at different last_timestamps and a
    // tick index means nothing across them.
    const answering = new Set<number>();
    const add = (last: number, res: number, ticks: number, holes: number[] | null): void => {
      const missing = new Set(holes ?? []);
      for (let k = 0; k <= ticks; k++) if (!missing.has(k)) answering.add(last - k * res);
    };
    add(prior.oracle.lastTimestamp, prior.oracle.resolution, prior.measurements.reachableDepthTicks,
        prior.measurements.tickCompletenessGaps);
    add(confirmedAt, resolution, confirmedDeepest, gaps);

    const sorted = [...answering].sort((a, b) => a - b);
    const lo = sorted[0] ?? 0;
    const hi = sorted[sorted.length - 1] ?? 0;
    const spanSeconds = hi - lo;
    const expected = resolution > 0 ? Math.floor(spanSeconds / resolution) + 1 : 0;
    const holes = expected - answering.size;
    union = {
      spanSeconds,
      points: answering.size,
      gaps: holes,
      completeness: expected > 0 ? answering.size / expected : 0,
      runs: [
        { at: prior.oracle.lastTimestamp, ticks: prior.measurements.reachableDepthTicks },
        { at: confirmedAt, ticks: confirmedDeepest },
      ],
    };
    record(
      'E-12',
      'the union of two sweeps spans more than 24 h, with the gap rate over that union',
      spanSeconds > 24 * 3600 && holes === 0 ? 'PASS' : spanSeconds > 24 * 3600 ? 'INFO' : 'FAIL',
      `union spans ${hms(spanSeconds)} over ${answering.size} answering grid points; ` +
        `${holes} gap(s); completeness ${(union.completeness * 100).toFixed(2)} %`,
      'One sweep can only see the reachable depth, so a single call can never cover 24 h — the ' +
        'oldest stretch of a 24-hour window is missing BY THE CAP, not by any gap. Two sweeps far ' +
        'enough apart cover it between them, and this row is the union computed from both records ' +
        'rather than a claim about them.',
    );
  } else if (env.full) {
    record(
      'E-12',
      'the union of two sweeps spans more than 24 h',
      'INFO',
      'not computed — pass --union-with <prior --full record> to close 06-TEST-PLAN §7b\'s union row',
    );
  }

  // -- Record and verdict ------------------------------------------------------------------------------
  const failures = checks.filter((c) => c.status === 'FAIL');
  const report = {
    tool: 'scripts/verify-environment.ts',
    generated: started,
    finished: new Date().toISOString(),
    mode: env.full ? 'full' : 'quick',
    network: env.network,
    rpc: env.rpcUrl,
    protocolVersion,
    rpcVersion: (await server.getVersionInfo().catch(() => ({ version: 'unknown' }))).version,
    oracle: { id: env.reflectorId, asset: `Other("${env.assetSymbol}")`, resolution, decimals, version, lastTimestamp },
    measurements: {
      reachableDepthTicks: deepestAnswering,
      reachableDepthSeconds: cutoffSeconds,
      requiredDepthSeconds: requiredSeconds,
      tickCompletenessGaps: env.full ? gaps : null,
      unionOfSweeps: union,
      sevenPointCostByAnchorAge: perAge,
      pricesCollapseAt: pricesCollapse,
      expires,
    },
    checks,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };

  console.log('');
  if (env.jsonOut !== undefined) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(env.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`record written to ${env.jsonOut}`);
  }

  if (failures.length === 0) {
    console.log(`VERDICT: PASS — ${checks.length} checks, ${checks.filter((c) => c.status === 'INFO').length} informational.`);
    return;
  }
  console.log(`VERDICT: FAIL — ${failures.length} of ${checks.length} checks failed:`);
  for (const f of failures) console.log(`  ${f.id}  ${f.what}`);
  console.log('');
  console.log('A failure here is a fact about the live network, not a bug in this script. 00-ROADMAP');
  console.log('Phase 1\'s gate is met by a green run OR by a filed finding: if the measured value');
  console.log('contradicts the design, the design\'s constant is what changes, and it changes in the');
  console.log('document before it changes in the adapter.');
  process.exitCode = 1;
}

await main();
