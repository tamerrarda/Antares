#!/usr/bin/env node
/**
 * `profile-adapter.ts` — the authoritative resource profile of the anchored read (DEV2.md §3.2).
 *
 * Phase 1's `verify-environment.ts` E-8 measures the seven-point battery as **seven separate
 * simulations** and says so: the adapter did not exist, and Soroban admits one
 * `InvokeHostFunction` per transaction, so seven `price()` calls could never share a budget. That
 * row is labelled a lower bound precisely so it would not quietly stand in for this one.
 *
 * This is the aggregate it was standing in for. `reading()` makes all seven samples inside **one**
 * invocation, so what is measured here is the number that actually has to fit: one transaction,
 * one budget, against the limits the network publishes today.
 *
 * # What the profile is for
 *
 * D-64 accepts one residual in writing — that budget exhaustion inside the anchored read is a
 * "never worked at all" failure rather than a latent time bomb. **That is a claim about
 * constancy, not about size.** A read that costs 40 % of the limit is fine forever; a read whose
 * cost grows with the anchor's age is a contract that works in testing and fails at the far end of
 * the reachable window, when a round is already open and the collateral is already committed. So
 * the size is recorded, and the *spread across anchor ages* is what the exit status is taken from.
 *
 * # It signs nothing
 *
 * Every call is a read-only `simulateTransaction`. The source account is used only because a
 * simulation must be built against an existing one.
 */

import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------------------------
// Constants owned by the design. Restated only so the profile can build an honest anchor grid; if
// one disagrees with its document, the document wins.
// ---------------------------------------------------------------------------------------------

/** `price-source-api::RECORD_CAP_TICKS`, measured at 255 in Phase 1 (D-69) — not 256. */
const RECORD_CAP_TICKS = 255;

/** The windows the vault ships (02-CONTRACT-SPEC §4). The grid is derived from these. */
const SHIPPED = { twap_window: 900, guard_window: 3600 };

/** The constancy bar. A read whose cost varies more than this across the reachable depth fails. */
const SPREAD_LIMIT_PCT = 5;

interface Env {
  readonly rpcUrl: string;
  readonly passphrase: string;
  readonly adapterId: string;
  readonly feedId: string;
  readonly sourceAccount: string | undefined;
  readonly jsonOut: string | undefined;
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\nMissing ${name}. See the header of this file.\n`);
    process.exit(2);
  }
  return v;
}

function readEnv(argv: readonly string[]): Env {
  const i = argv.indexOf('--json');
  return {
    rpcUrl: need('RPC_URL'),
    passphrase: need('NETWORK_PASSPHRASE'),
    adapterId: need('ADAPTER_ID'),
    feedId: need('FEED_ID'),
    sourceAccount: process.env['SOURCE_ACCOUNT']?.trim() || undefined,
    jsonOut: i >= 0 ? argv[i + 1] : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

interface Cost {
  readonly value: unknown;
  readonly error: string | undefined;
  /** CPU instructions, as the simulation budgets them. */
  readonly cpu: number;
  readonly readBytes: number;
  readonly readEntries: number;
  /** Resource fee in stroops, as the network prices this call today. */
  readonly fee: number;
}

class Sim {
  readonly #server: rpc.Server;
  readonly #source: Awaited<ReturnType<rpc.Server['getAccount']>>;
  readonly #passphrase: string;

  private constructor(
    server: rpc.Server,
    source: Awaited<ReturnType<rpc.Server['getAccount']>>,
    passphrase: string,
  ) {
    this.#server = server;
    this.#source = source;
    this.#passphrase = passphrase;
  }

  static async connect(env: Env): Promise<Sim> {
    const server = new rpc.Server(env.rpcUrl);
    let pubkey = env.sourceAccount;
    if (pubkey === undefined) {
      const kp = Keypair.random();
      const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(kp.publicKey())}`);
      if (!res.ok) {
        console.error(`\nfriendbot funding failed (${res.status}). Pass SOURCE_ACCOUNT=G... instead.\n`);
        process.exit(2);
      }
      pubkey = kp.publicKey();
    }
    return new Sim(server, await server.getAccount(pubkey), env.passphrase);
  }

  get server(): rpc.Server {
    return this.#server;
  }

  async call(id: string, fn: string, ...args: xdr.ScVal[]): Promise<Cost> {
    const tx = new TransactionBuilder(this.#source, {
      fee: '10000000',
      networkPassphrase: this.#passphrase,
    })
      .addOperation(new Contract(id).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.#server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { value: null, error: sim.error, cpu: 0, readBytes: 0, readEntries: 0, fee: 0 };
    }
    const r = sim.transactionData?.build().resources();
    return {
      value: sim.result === undefined ? null : scValToNative(sim.result.retval),
      error: undefined,
      cpu: Number(r?.instructions() ?? 0),
      readBytes: Number(r?.diskReadBytes() ?? 0),
      readEntries: Number(r?.footprint().readOnly().length ?? 0),
      fee: Number(sim.minResourceFee ?? 0),
    };
  }
}

/** The limits the network publishes **today**, read live rather than pinned (D-49, D-58). */
async function liveLimits(server: rpc.Server): Promise<{ txMaxInstructions: number; txMaxDiskReadBytes: number }> {
  const key = (id: xdr.ConfigSettingId) =>
    xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id }));
  const r = await server.getLedgerEntries(
    key(xdr.ConfigSettingId.configSettingContractComputeV0()),
    key(xdr.ConfigSettingId.configSettingContractLedgerCostV0()),
  );
  let txMaxInstructions = 0;
  let txMaxDiskReadBytes = 0;
  for (const e of r.entries) {
    const cs = e.val.configSetting();
    if (cs.switch().name === 'configSettingContractComputeV0') {
      txMaxInstructions = Number(cs.contractCompute().txMaxInstructions().toString());
    } else if (cs.switch().name === 'configSettingContractLedgerCostV0') {
      txMaxDiskReadBytes = Number(cs.contractLedgerCost().txMaxDiskReadBytes().toString());
    }
  }
  return { txMaxInstructions, txMaxDiskReadBytes };
}

/** `scValToNative` hands back `bigint` for i128/u64, which `JSON.stringify` refuses outright. */
const show = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const hms = (s: number): string => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const pct = (a: number, b: number): string => `${((a / b) * 100).toFixed(2)} %`;

// ---------------------------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readEnv(process.argv.slice(2));
  const started = new Date().toISOString();
  const sim = await Sim.connect(env);

  console.log('');
  console.log(`  adapter   ${env.adapterId}`);
  console.log(`  feed      ${env.feedId}`);
  console.log(`  started   ${started}`);
  console.log('');

  // -- the grid the anchors are built on ------------------------------------------------------
  // Read from the feed rather than assumed. A profile built on a stale resolution would sample
  // between ticks and measure a sparse feed's cost instead of a healthy one's.
  const resCall = await sim.call(env.feedId, 'resolution');
  const tsCall = await sim.call(env.feedId, 'last_timestamp');
  const resolution = Number(resCall.value);
  const lastTimestamp = Number(tsCall.value);
  if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(lastTimestamp)) {
    console.error('  the feed did not answer resolution()/last_timestamp() — nothing can be profiled');
    process.exit(2);
  }

  const reach = RECORD_CAP_TICKS * resolution;
  const guardTicks = Math.ceil(SHIPPED.guard_window / resolution);
  const deepest = RECORD_CAP_TICKS - guardTicks - 1;
  console.log(`  resolution ${resolution}s   reachable depth ${RECORD_CAP_TICKS} ticks = ${hms(reach)}`);
  console.log(`  guard_window spans ${guardTicks} ticks, so the deepest whole window ends ${deepest} ticks back`);
  console.log('');

  const limits = await liveLimits(sim.server);
  console.log(`  live limits: txMaxInstructions ${limits.txMaxInstructions}, txMaxDiskReadBytes ${limits.txMaxDiskReadBytes}`);
  console.log('');

  // -- the seven anchor ages ------------------------------------------------------------------
  // Spread across the reachable depth rather than clustered near `now`: the whole question is
  // whether the far end costs more than the near end, and a grid that only samples the near end
  // cannot answer it.
  // The last entry is deliberately **past** the reachable depth. It is not part of the constancy
  // question — it is the other branch of the same read, and D-59's whole finding was that this
  // branch used to be indistinguishable from a dead feed. Profiling it live proves the adapter
  // answers `OutOfReach` rather than erroring, and prices what that answer costs.
  const ageTicks = [1, 12, 48, 96, 150, 200, deepest, RECORD_CAP_TICKS + 1].filter((k) => k > 0);
  const tw = nativeToScVal(SHIPPED.twap_window, { type: 'u64' });
  const gw = nativeToScVal(SHIPPED.guard_window, { type: 'u64' });

  const rows: { ageTicks: number; ageSeconds: number; cost: Cost; variant: string }[] = [];
  for (const k of ageTicks) {
    const anchor = lastTimestamp - k * resolution;
    const cost = await sim.call(env.adapterId, 'reading', nativeToScVal(anchor, { type: 'u64' }), tw, gw);
    // A Soroban enum arrives as `['Reading', {..}]` — a *vec*, not an object. Reading the tag with
    // `Object.keys(v)[0]` yields the string `'0'`, which no `variant === 'Reading'` filter matches:
    // the profile then compares an empty set and reports a 0 % spread for every possible input.
    // Caught because the variant column printed `0` for rows that plainly returned a price.
    const v = cost.value;
    const variant =
      cost.error !== undefined
        ? 'ERROR'
        : Array.isArray(v)
          ? String(v[0])
          : v === null
            ? 'null'
            : typeof v === 'object'
              ? (Object.keys(v as object)[0] ?? 'object')
              : String(v);
    rows.push({ ageTicks: k, ageSeconds: k * resolution, cost, variant });
  }

  console.log('  reading(anchor, 900, 3600) — one transaction, the whole seven-point battery');
  console.log('');
  console.log('    age            anchor      variant     CPU insn   % of limit   read B   entries   fee');
  for (const r of rows) {
    console.log(
      `    ${hms(r.ageSeconds).padEnd(9)} ${String(r.ageTicks).padStart(3)}t  ` +
        `${r.variant.padEnd(11)} ${String(r.cost.cpu).padStart(9)}   ` +
        `${pct(r.cost.cpu, limits.txMaxInstructions).padStart(8)}   ` +
        `${String(r.cost.readBytes).padStart(6)}   ${String(r.cost.readEntries).padStart(7)}   ${r.cost.fee}`,
    );
  }
  console.log('');

  // -- the two other entry points, for the record ---------------------------------------------
  const spot = await sim.call(
    env.adapterId,
    'spot_check',
    nativeToScVal(900, { type: 'u64' }),
    nativeToScVal(14, { type: 'u32' }),
  );
  const supports = await sim.call(
    env.adapterId,
    'supports_round',
    ...[900, 3600, 3600, 600, 73200, 159600].map((n) => nativeToScVal(n, { type: 'u64' })),
  );
  console.log(`  spot_check(900, 14)      ${String(spot.cpu).padStart(9)} insn   ${pct(spot.cpu, limits.txMaxInstructions)}   -> ${show(spot.value)}`);
  console.log(`  supports_round(shipped)  ${String(supports.cpu).padStart(9)} insn   ${pct(supports.cpu, limits.txMaxInstructions)}   -> ${show(supports.value)}`);
  console.log('');

  // -- the verdict ----------------------------------------------------------------------------
  // Taken from the spread, not from the size. See the header: D-64's residual is a claim about
  // constancy. Only rows that actually returned a reading are compared — an `OutOfReach` answer
  // is a different code path and folding it in would flatter or wreck the spread by accident.
  const readable = rows.filter((r) => r.variant === 'Reading' && r.ageTicks <= deepest);
  const cpus = readable.map((r) => r.cost.cpu);
  const lo = Math.min(...cpus);
  const hi = Math.max(...cpus);
  const spreadPct = cpus.length > 1 && lo > 0 ? ((hi - lo) / lo) * 100 : 0;
  const worstPct = (hi / limits.txMaxInstructions) * 100;

  const constant = cpus.length > 1 && spreadPct < SPREAD_LIMIT_PCT;
  const fits = hi > 0 && hi < limits.txMaxInstructions;

  // The bare spread cannot tell a *trend with depth* — the failure D-64 actually fears — from a
  // one-off step at the shallow end, and the two mean opposite things. So the deep tail is
  // reported on its own: if the cost grows with the anchor's age, it shows up here and nowhere
  // else. On the first run the entire spread was a single extra ledger entry between the 1-tick
  // and 12-tick anchors, and the tail from 12 to 242 ticks was flat to 0.039 %.
  const tail = readable.filter((r) => r.ageTicks >= guardTicks);
  const tailCpus = tail.map((r) => r.cost.cpu);
  const tailLo = Math.min(...tailCpus);
  const tailHi = Math.max(...tailCpus);
  const tailSpread = tailCpus.length > 1 && tailLo > 0 ? ((tailHi - tailLo) / tailLo) * 100 : 0;

  console.log(`  readable anchors profiled : ${readable.length} of ${rows.length}`);
  console.log(`  CPU spread across depth   : ${spreadPct.toFixed(3)} %  (${lo} .. ${hi})`);
  console.log(`  spread over the deep tail : ${tailSpread.toFixed(3)} %  (${tail.length} anchors from ${guardTicks}t to ${deepest}t)`);
  console.log(`  entries read, by depth    : ${readable.map((r) => `${r.ageTicks}t:${r.cost.readEntries}`).join('  ')}`);
  console.log(`  worst case against limit  : ${worstPct.toFixed(2)} %`);
  console.log('');
  console.log(`  ${constant && fits ? 'PASS' : 'FAIL'}  ${constant ? 'cost does not vary with the anchor age' : 'COST VARIES WITH THE ANCHOR AGE — D-64’s residual does not hold'}`);
  console.log('');

  if (env.jsonOut !== undefined) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      env.jsonOut,
      JSON.stringify(
        {
          started,
          // D-69's discipline: a measurement without provenance is an anecdote. What was
          // measured, with what, at which commit, against which address.
          provenance: {
            commit: process.env['COMMIT']?.trim() ?? '(not supplied)',
            wasmSha256: process.env['WASM_SHA256']?.trim() ?? '(not supplied)',
            rpcUrl: env.rpcUrl,
            networkPassphrase: env.passphrase,
            sourceAccount: env.sourceAccount ?? '(ephemeral friendbot account)',
          },
          adapter: env.adapterId,
          feed: env.feedId,
          resolution,
          lastTimestamp,
          limits,
          shipped: SHIPPED,
          rows: rows.map((r) => ({
            ageTicks: r.ageTicks,
            ageSeconds: r.ageSeconds,
            variant: r.variant,
            cpu: r.cost.cpu,
            readBytes: r.cost.readBytes,
            readEntries: r.cost.readEntries,
            fee: r.cost.fee,
          })),
          spotCheck: { cpu: spot.cpu, fee: spot.fee, value: spot.value },
          supportsRound: { cpu: supports.cpu, fee: supports.fee, value: supports.value },
          spreadPct,
          tailSpreadPct: tailSpread,
          worstPct,
          verdict: constant && fits ? 'PASS' : 'FAIL',
        },
        (_k, x) => (typeof x === 'bigint' ? x.toString() : x),
        2,
      ) + '\n',
    );
    console.log(`  recorded -> ${env.jsonOut}`);
    console.log('');
  }

  process.exit(constant && fits ? 0 : 1);
}

await main();
