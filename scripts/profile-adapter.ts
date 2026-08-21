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
} from "@stellar/stellar-sdk";

import { RECORD_CAP_TICKS, reachSeconds } from "@antares/common/oracle";

import { networkLimits } from "@antares/common/limits";

// ---------------------------------------------------------------------------------------------
// Constants owned by the design. Restated only so the profile can build an honest anchor grid; if
// one disagrees with its document, the document wins.
// ---------------------------------------------------------------------------------------------

// RECORD_CAP_TICKS is imported rather than restated — packages/common/oracle.ts, and D-69 for why
// it is 255 rather than 256.

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
  const i = argv.indexOf("--json");
  return {
    rpcUrl: need("RPC_URL"),
    passphrase: need("NETWORK_PASSPHRASE"),
    adapterId: need("ADAPTER_ID"),
    feedId: need("FEED_ID"),
    sourceAccount: process.env["SOURCE_ACCOUNT"]?.trim() || undefined,
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
  readonly #source: Awaited<ReturnType<rpc.Server["getAccount"]>>;
  readonly #passphrase: string;

  private constructor(
    server: rpc.Server,
    source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
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
      fee: "10000000",
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

/**
 * `scValToNative` hands back `bigint` for i128/u64, which `JSON.stringify` refuses outright.
 *
 * Written as a named, typed replacer rather than an inline arrow at each call site: the replacer's
 * value parameter is `any` by declaration, so returning it unchanged leaks `any` into whatever
 * consumes the result — which is what `no-unsafe-return` was telling me at both call sites.
 */
const bigintSafe = (_k: string, x: unknown): unknown => (typeof x === "bigint" ? x.toString() : x);

/** How a primitive renders in a report. Total, so no branch can fall through to `[object Object]`. */
const primitive = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return v.toString();
  if (v === null || v === undefined) return String(v);
  return typeof v;
};

/**
 * The tag of a returned value.
 *
 * A Soroban enum arrives as `['Reading', {..}]` — a *vec*, not an object. Reading the tag with
 * `Object.keys(v)[0]` yields the string `'0'`, which no `variant === 'Reading'` filter matches:
 * the profile then compares an empty set and reports a 0 % spread for every possible input. Caught
 * because the variant column printed `0` for rows that plainly returned a price.
 */
const variantOf = (v: unknown): string => {
  if (Array.isArray(v)) return primitive((v as unknown[])[0]);
  if (v === null) return "null";
  if (typeof v === "object") return Object.keys(v)[0] ?? "object";
  return primitive(v);
};

const show = (v: unknown): string => JSON.stringify(v, bigintSafe);

const hms = (s: number): string => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const pct = (a: number, b: number): string => `${((a / b) * 100).toFixed(2)} %`;

// ---------------------------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readEnv(process.argv.slice(2));
  const started = new Date().toISOString();
  const sim = await Sim.connect(env);

  console.log("");
  console.log(`  adapter   ${env.adapterId}`);
  console.log(`  feed      ${env.feedId}`);
  console.log(`  started   ${started}`);
  console.log("");

  // -- the grid the anchors are built on ------------------------------------------------------
  // Read from the feed rather than assumed. A profile built on a stale resolution would sample
  // between ticks and measure a sparse feed's cost instead of a healthy one's.
  const resCall = await sim.call(env.feedId, "resolution");
  const tsCall = await sim.call(env.feedId, "last_timestamp");
  const resolution = Number(resCall.value);
  const lastTimestamp = Number(tsCall.value);
  if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(lastTimestamp)) {
    console.error("  the feed did not answer resolution()/last_timestamp() — nothing can be profiled");
    process.exit(2);
  }

  const reach = reachSeconds(resolution);
  const guardTicks = Math.ceil(SHIPPED.guard_window / resolution);
  const deepest = RECORD_CAP_TICKS - guardTicks - 1;
  console.log(`  resolution ${resolution}s   reachable depth ${RECORD_CAP_TICKS} ticks = ${hms(reach)}`);
  console.log(
    `  guard_window spans ${guardTicks} ticks, so the deepest whole window ends ${deepest} ticks back`,
  );
  console.log("");

  const limits = await networkLimits(sim.server);
  console.log(
    `  live limits: txMaxInstructions ${limits.txMaxInstructions}, txMaxDiskReadBytes ${limits.txMaxDiskReadBytes}`,
  );
  console.log("");

  // -- the seven anchor ages ------------------------------------------------------------------
  // Spread across the reachable depth rather than clustered near `now`: the whole question is
  // whether the far end costs more than the near end, and a grid that only samples the near end
  // cannot answer it.
  // The last entry is deliberately **past** the reachable depth. It is not part of the constancy
  // question — it is the other branch of the same read, and D-59's whole finding was that this
  // branch used to be indistinguishable from a dead feed. Profiling it live proves the adapter
  // answers `OutOfReach` rather than erroring, and prices what that answer costs.
  const ageTicks = [1, 12, 48, 96, 150, 200, deepest, RECORD_CAP_TICKS + 1].filter((k) => k > 0);
  const tw = nativeToScVal(SHIPPED.twap_window, { type: "u64" });
  const gw = nativeToScVal(SHIPPED.guard_window, { type: "u64" });

  const rows: { ageTicks: number; ageSeconds: number; cost: Cost; variant: string }[] = [];
  for (const k of ageTicks) {
    const anchor = lastTimestamp - k * resolution;
    const cost = await sim.call(env.adapterId, "reading", nativeToScVal(anchor, { type: "u64" }), tw, gw);
    const variant = cost.error !== undefined ? "ERROR" : variantOf(cost.value);
    rows.push({ ageTicks: k, ageSeconds: k * resolution, cost, variant });
  }

  console.log("  reading(anchor, 900, 3600) — one transaction, the whole seven-point battery");
  console.log("");
  console.log("    age            anchor      variant     CPU insn   % of limit   read B   entries   fee");
  for (const r of rows) {
    console.log(
      `    ${hms(r.ageSeconds).padEnd(9)} ${String(r.ageTicks).padStart(3)}t  ` +
        `${r.variant.padEnd(11)} ${String(r.cost.cpu).padStart(9)}   ` +
        `${pct(r.cost.cpu, limits.txMaxInstructions).padStart(8)}   ` +
        `${String(r.cost.readBytes).padStart(6)}   ${String(r.cost.readEntries).padStart(7)}   ${r.cost.fee}`,
    );
  }
  console.log("");

  // -- the other two entry points -------------------------------------------------------------
  const spot = await sim.call(
    env.adapterId,
    "spot_check",
    nativeToScVal(900, { type: "u64" }),
    nativeToScVal(14, { type: "u32" }),
  );
  console.log(
    `  spot_check(900, 14)      ${String(spot.cpu).padStart(9)} insn   ${pct(spot.cpu, limits.txMaxInstructions)}   -> ${show(spot.value)}`,
  );

  // -- O-13, against the real feed --------------------------------------------------------------
  // The rejection matrix is one of the few failure families a *healthy* feed can still produce,
  // because every input is a parameter and the only thing the feed contributes is its own
  // `resolution()` and `expires()`. So it is re-run here rather than left to the mock — and each
  // rejection moves ONE value by ONE second, because a blanket `false` is indistinguishable from
  // an adapter that rejects everything.
  const reachLimit = reach - SHIPPED.guard_window;
  const SPAN = 159_600;
  const matrix: {
    id: string;
    why: string;
    tw: number;
    gw: number;
    oda: number;
    sg: number;
    ua: number;
    span: number;
    expect: boolean;
  }[] = [
    {
      id: "O-13/pass",
      why: "the shipped set",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: SPAN,
      expect: true,
    },
    {
      id: "O-13/c1",
      why: `condition 1: twap_window ${resolution + 1} cannot hold three ticks at res ${resolution}`,
      tw: resolution + 1,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13/c2",
      why: "condition 2: tw 3000 / gw 3100 — passes guard > twap, fails on the REALIZED spans (04-ORACLE’s worked counter-example)",
      tw: 3000,
      gw: 3100,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13/c4",
      why: "condition 4: oracle_dead_after + guard_window + settle_grace >= R",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: reach,
      sg: 600,
      ua: reachLimit + 300,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13b",
      why: `condition 3 floor: unresolved_after == reach_limit (${reachLimit})`,
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13b+",
      why: "one second above the floor",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 1,
      span: SPAN,
      expect: true,
    },
    {
      id: "O-13c-",
      why: `condition 6 ceiling: reach_limit + settle_grace (${reachLimit + 600})`,
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 600,
      span: SPAN,
      expect: true,
    },
    {
      id: "O-13c",
      why: "one second above the ceiling",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 601,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13d",
      why: "evaluation order: guard_window of one year, rejected by condition 4 BEFORE R − guard_window is reached",
      tw: SHIPPED.twap_window,
      gw: 31_536_000,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: SPAN,
      expect: false,
    },
    {
      id: "O-13f/skip",
      why: "round_span = 0 skips condition 7",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: 0,
      expect: true,
    },
    {
      id: "O-13f",
      why: "condition 7: round_span outruns the feed’s own funding",
      tw: SHIPPED.twap_window,
      gw: SHIPPED.guard_window,
      oda: 3600,
      sg: 600,
      ua: reachLimit + 300,
      span: 2_000_000,
      expect: false,
    },
  ];
  const matrixRows: {
    id: string;
    why: string;
    params: Record<string, number>;
    expected: boolean;
    actual: unknown;
    cpu: number;
  }[] = [];
  for (const m of matrix) {
    const r = await sim.call(
      env.adapterId,
      "supports_round",
      ...[m.tw, m.gw, m.oda, m.sg, m.ua, m.span].map((n) => nativeToScVal(n, { type: "u64" })),
    );
    matrixRows.push({
      id: m.id,
      why: m.why,
      params: {
        twap_window: m.tw,
        guard_window: m.gw,
        oracle_dead_after: m.oda,
        settle_grace: m.sg,
        unresolved_after: m.ua,
        round_span: m.span,
      },
      expected: m.expect,
      actual: r.value,
      cpu: r.cpu,
    });
  }
  const matrixOk = matrixRows.every((r) => r.actual === matrix.find((m) => m.id === r.id)?.expect);
  console.log(
    `  supports_round matrix    ${matrixRows.length} cases, ${matrixOk ? "all as specified" : "MISMATCH"}`,
  );

  // -- the reach boundary, bracketed ------------------------------------------------------------
  // D-69's cap is the number every other constant derives from, so it is measured against the real
  // feed rather than trusted. Anchors are snapped to the tick, so the transition can only be
  // located to within one tick — the pair that brackets it is the measurement, not a single value.
  const wallNow = Math.floor(Date.now() / 1000);
  const tickFloor = (t: number) => Math.floor(t / resolution) * resolution;
  let lastRead: number | undefined;
  let firstOor: number | undefined;
  for (
    let end = tickFloor(wallNow - reachLimit + 2 * resolution);
    end > wallNow - reachLimit - 3 * resolution;
    end -= resolution
  ) {
    const r = await sim.call(env.adapterId, "reading", nativeToScVal(end, { type: "u64" }), tw, gw);
    const tag = variantOf(r.value);
    if (tag === "Reading") lastRead = wallNow - end;
    else if (tag === "OutOfReach" && lastRead !== undefined) {
      firstOor = wallNow - end;
      break;
    }
  }
  const boundaryOk =
    lastRead !== undefined && firstOor !== undefined && lastRead <= reachLimit && firstOor > reachLimit;
  console.log(
    `  reach boundary           reads at now-${lastRead}s, OutOfReach at now-${firstOor}s, brackets ${reachLimit}`,
  );

  // -- what is actually running on the chain ----------------------------------------------------
  // D-50 end to end. Until this call the rule was a CI job about two local checkouts; fetching the
  // code back off the network turns it into a statement about the thing users would be trusting.
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const onChain = await sim.server.getContractWasmByContractId(env.adapterId);
  const onChainSha = createHash("sha256").update(onChain).digest("hex");
  const localPath = process.env["WASM_PATH"]?.trim();
  const localSha =
    localPath === undefined ? undefined : createHash("sha256").update(readFileSync(localPath)).digest("hex");
  const shaMatches = localSha !== undefined && localSha === onChainSha;

  // The export surface, parsed off the bytes the network served — not off our source tree. This is
  // the claim 09-DEPLOYMENT §2 makes at deploy time and 04-ORACLE §1 explains: no admin, no
  // upgrade, no setter. Anyone can now check it without our repository.
  const exportsOf = (b: Uint8Array): string[] => {
    const out: string[] = [];
    let i = 8;
    const leb = (): number => {
      let r = 0;
      let s = 0;
      // Declared without an initial value: the `do` body assigns before the condition reads it, so
      // a `0` here is written and never used.
      let x: number;
      do {
        x = b[i++]!;
        r |= (x & 0x7f) << s;
        s += 7;
      } while (x & 0x80);
      return r;
    };
    while (i < b.length) {
      const id = b[i++]!;
      const size = leb();
      const end = i + size;
      if (id === 7) {
        const n = leb();
        for (let k = 0; k < n; k++) {
          const len = leb();
          const name = new TextDecoder().decode(b.subarray(i, i + len));
          i += len;
          const kind = b[i++]!;
          leb();
          if (kind === 0) out.push(name);
        }
      }
      i = end;
    }
    return out.sort();
  };
  const exported = exportsOf(new Uint8Array(onChain));
  const EXPECTED_EXPORTS = ["__constructor", "reading", "spot_check", "supports_round"];
  const surfaceOk = JSON.stringify(exported) === JSON.stringify(EXPECTED_EXPORTS);
  console.log(`  on-chain export surface  ${exported.join(" ")}`);
  console.log(
    `  on-chain sha256          ${onChainSha}${shaMatches ? "  == local build" : localSha === undefined ? "  (no WASM_PATH given)" : "  != local build"}`,
  );
  console.log("");

  // -- the verdict ------------------------------------------------------------------------------
  // Taken from the spread, not from the size. See the header: D-64's residual is a claim about
  // constancy. Only rows that actually returned a reading are compared — an `OutOfReach` answer
  // is a different code path and folding it in would flatter or wreck the spread by accident.
  const readable = rows.filter((r) => r.variant === "Reading" && r.ageTicks <= deepest);
  const cpus = readable.map((r) => r.cost.cpu);
  const lo = Math.min(...cpus);
  const hi = Math.max(...cpus);
  const spreadPct = cpus.length > 1 && lo > 0 ? ((hi - lo) / lo) * 100 : 0;
  const worstPct = (hi / limits.txMaxInstructions) * 100;

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

  const oor = rows.find((r) => r.ageTicks > deepest);
  const constant = tailCpus.length > 1 && tailSpread < SPREAD_LIMIT_PCT;
  const fits = hi > 0 && hi < limits.txMaxInstructions;

  const checks = [
    {
      id: "P-1",
      what: "the deployed wasm is byte-identical to the local build (D-50, end to end)",
      status: shaMatches ? "PASS" : localSha === undefined ? "SKIP" : "FAIL",
      measured: `on-chain sha256 ${onChainSha}, ${onChain.length} bytes; local ${localSha ?? "(not given)"}`,
      note: "Until this was fetched back off the network, D-50 was a rule about two local checkouts. It is now a statement about what is running.",
    },
    {
      id: "P-2",
      what: "the on-chain export surface is exactly four functions — no admin, no upgrade, no setter",
      status: surfaceOk ? "PASS" : "FAIL",
      measured: exported.join(", "),
      note: "09-DEPLOYMENT §2 asserts this at deploy time and 04-ORACLE §1 explains why the adapter is immutable. Parsed from the bytes the network served, so it is checkable without this repository.",
    },
    {
      id: "P-3",
      what: "the seven-point read fits the live transaction limit",
      status: fits ? "PASS" : "FAIL",
      measured: `worst ${hi} of txMaxInstructions ${limits.txMaxInstructions} = ${worstPct.toFixed(2)} %`,
      note: "One InvokeHostFunction carries all seven samples, so this is the aggregate E-8 was a lower bound for.",
    },
    {
      id: "P-4",
      what: "the read’s cost does NOT vary with the anchor’s age — the deep tail",
      status: constant ? "PASS" : "FAIL",
      measured: `${tail.length} anchors from ${guardTicks}t to ${deepest}t spread ${tailSpread.toFixed(3)} % (${tailLo}..${tailHi})`,
      note: "This is the half D-64’s residual rests on. A trend here would mean the contract works in testing and fails at the far end of the window with a round already open.",
    },
    {
      id: "P-5",
      what: "the whole-range spread is a step, not a trend",
      status: "INFO",
      measured: `whole range ${spreadPct.toFixed(3)} % (${lo}..${hi}); entries by depth ${readable.map((r) => `${r.ageTicks}t:${r.cost.readEntries}`).join(" ")}`,
      note: "Recorded separately because a single spread number cannot distinguish the two, and only the trend is a failure. The step is one extra ledger entry at the shallow end.",
    },
    {
      id: "P-6",
      what: "past the reachable depth the adapter answers OutOfReach rather than erroring",
      status: oor?.variant === "OutOfReach" ? "PASS" : "FAIL",
      measured: `at ${oor?.ageTicks}t: ${oor?.variant}, ${oor?.cost.cpu} insn, ${oor?.cost.readEntries} entries`,
      note: "D-59 made visible: the answer is cheap precisely because no evidence is gathered, since none can exist there.",
    },
    {
      id: "P-7",
      what: "O-13’s rejection matrix, re-run against the real feed",
      status: matrixOk ? "PASS" : "FAIL",
      measured: matrixRows.map((r) => `${r.id}:${String(r.actual)}`).join(" "),
      note: "The only failure family a healthy feed can still produce, because every input is a parameter and the feed contributes only its own resolution() and expires(). Each rejection moves one value by one second.",
    },
    {
      id: "P-8",
      what: "the reach limit derived from the 255-tick cap holds against the real feed (D-69)",
      status: boundaryOk ? "PASS" : "FAIL",
      measured: `reads at now-${lastRead}s, OutOfReach at now-${firstOor}s; reach_limit ${reachLimit} = ${RECORD_CAP_TICKS} × ${resolution} − ${SHIPPED.guard_window}`,
      note: "Anchors snap to the tick, so the transition can only be located to within one tick; the bracketing pair is the measurement.",
    },
  ];
  const verdict = checks.some((c) => c.status === "FAIL") ? "FAIL" : "PASS";

  console.log(`  readable anchors profiled : ${readable.length} of ${rows.length}`);
  console.log(`  CPU spread across depth   : ${spreadPct.toFixed(3)} %  (${lo} .. ${hi})`);
  console.log(
    `  spread over the deep tail : ${tailSpread.toFixed(3)} %  (${tail.length} anchors from ${guardTicks}t to ${deepest}t)`,
  );
  console.log(
    `  entries read, by depth    : ${readable.map((r) => `${r.ageTicks}t:${r.cost.readEntries}`).join("  ")}`,
  );
  console.log(`  worst case against limit  : ${worstPct.toFixed(2)} %`);
  console.log("");
  for (const c of checks) console.log(`  ${c.status.padEnd(5)} ${c.id}  ${c.what}`);
  console.log("");
  console.log(`  ${verdict}`);
  console.log("");

  if (env.jsonOut !== undefined) {
    const { writeFileSync } = await import("node:fs");
    const version = await sim.server.getVersionInfo();
    writeFileSync(
      env.jsonOut,
      JSON.stringify(
        {
          tool: "scripts/profile-adapter.ts",
          generated: started,
          finished: new Date().toISOString(),
          network: "testnet",
          rpc: env.rpcUrl,
          protocolVersion: version.protocolVersion,
          rpcVersion: version.version,
          toolchain: {
            // Two commits, deliberately. D-50's claim is about the commit the **wasm** was built
            // at; the profile can be re-run later from a tree that has moved on, and conflating
            // the two would let a matching hash be reported against the wrong source.
            wasmBuiltAtCommit: process.env["WASM_COMMIT"]?.trim() ?? "(not supplied)",
            profiledAtCommit: process.env["COMMIT"]?.trim() ?? "(not supplied)",
            stellarCli: process.env["STELLAR_CLI_VERSION"]?.trim() ?? "(not supplied)",
            rustc: process.env["RUSTC_VERSION"]?.trim() ?? "(not supplied)",
            node: process.version,
          },
          deployment: {
            adapter: env.adapterId,
            feed: env.feedId,
            asset: 'Other("XLM")',
            deployer: env.sourceAccount ?? "(ephemeral)",
            wasmBytes: onChain.length,
            wasmSha256OnChain: onChainSha,
            wasmSha256Local: localSha ?? "(not supplied)",
            exportedFunctions: exported,
          },
          measurements: {
            resolution,
            decimals: 14,
            lastTimestamp,
            reachableDepthTicks: RECORD_CAP_TICKS,
            reachLimitSeconds: reachLimit,
            reachBoundary: { readsAtAgeSeconds: lastRead ?? null, outOfReachAtAgeSeconds: firstOor ?? null },
            limits,
            shipped: SHIPPED,
            // The seven readings themselves, not their range: a range cannot be re-checked and a
            // re-run of the script can give different numbers.
            readingByAnchorAge: rows.map((r) => ({
              ageTicks: r.ageTicks,
              ageSeconds: r.ageSeconds,
              variant: r.variant,
              cpuInstructions: r.cost.cpu,
              readBytes: r.cost.readBytes,
              readEntries: r.cost.readEntries,
              resourceFeeStroops: r.cost.fee,
            })),
            spotCheck: { cpuInstructions: spot.cpu, resourceFeeStroops: spot.fee, value: spot.value },
            supportsRoundMatrix: matrixRows,
            spreadPctWholeRange: spreadPct,
            spreadPctDeepTail: tailSpread,
            worstPctOfTxLimit: worstPct,
          },
          checks,
          verdict,
        },
        bigintSafe,
        2,
      ) + "\n",
    );
    console.log(`  recorded -> ${env.jsonOut}`);
    console.log("");
  }

  process.exit(verdict === "PASS" ? 0 : 1);
}

await main();
