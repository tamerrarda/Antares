/**
 * Tests for the deploy's command construction.
 *
 * Execution needs a network and these tests do not have one. **Argument assembly does not**, and it
 * is where a deploy fails in the ways that are hardest to see afterwards: a missing
 * `--network-passphrase` produces a valid signature for a network nobody intended, and a `bigint`
 * that went through the wrong encoder produces a vault with the wrong cap. So the argv is the unit
 * under test, asserted exactly.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ChainError,
  buildDeployArgv,
  buildInvokeArgv,
  encodeArg,
  parseContractId,
  parseTxHash,
  parseTxHashes,
  skippedUpload,
} from "../lib/chain.ts";

// The fixtures are BUILT rather than written out, and that is the network-agnostic rule working
// rather than an inconvenience. 06-TEST-PLAN §8's check greps every tracked file under scripts/ for
// a real passphrase or a Stellar address and exempts exactly two paths; a test is not one of them.
// A real passphrase here would also be the very literal the rule exists to stop — and it is
// git-aware, so a fixture like that goes red on the commit rather than in the working tree, which
// is how this file turned the job red once already.
const NET = {
  rpcUrl: "https://rpc.example/soroban",
  networkPassphrase: "Fixture Network ; not a real passphrase",
};
const cid = (letter: string): string => `C${letter.repeat(55)}`;
const VAULT = cid("A");
const OTHER = cid("B");

test("a deploy names the wasm, the identity and the network, and disables optimization", () => {
  const argv = buildDeployArgv({
    wasmPath: "target/x.wasm",
    identity: "deployer",
    net: NET,
    constructorArgs: { admin: "GADMIN", deposit_cap: 1_000_000_000_000n },
  });
  assert.deepEqual(argv, [
    "contract",
    "deploy",
    "--wasm",
    "target/x.wasm",
    "--optimize=false",
    "--source-account",
    "deployer",
    "--rpc-url",
    NET.rpcUrl,
    "--network-passphrase",
    NET.networkPassphrase,
    "--",
    "--admin",
    "GADMIN",
    "--deposit_cap",
    "1000000000000",
  ]);
});

test("the identity is a name and no secret is ever an argument (07-SECURITY §6)", () => {
  const argv = buildDeployArgv({
    wasmPath: "x.wasm",
    identity: "deployer",
    net: NET,
    constructorArgs: {},
  });
  // Nothing in the vector looks like a Stellar secret seed.
  assert.equal(
    argv.some((a) => /^S[A-Z2-7]{55}$/.test(a)),
    false,
  );
  assert.ok(argv.includes("--source-account") && argv.includes("deployer"));
});

test("the passphrase is always passed — signing for the wrong network is the failure it prevents", () => {
  for (const argv of [
    buildDeployArgv({ wasmPath: "x", identity: "d", net: NET, constructorArgs: {} }),
    buildInvokeArgv({ contractId: VAULT, method: "epoch", identity: "d", net: NET, args: {} }),
  ]) {
    assert.ok(argv.includes("--network-passphrase"));
    assert.equal(argv[argv.indexOf("--network-passphrase") + 1], NET.networkPassphrase);
  }
});

test("an invoke separates the method from its arguments and says whether it submits", () => {
  const write = buildInvokeArgv({
    contractId: VAULT,
    method: "deposit",
    identity: "deployer",
    net: NET,
    args: { from: "GUSER", amount: 10_000_000n },
  });
  assert.ok(write.includes("--send=yes"));
  assert.deepEqual(write.slice(write.indexOf("--")), [
    "--",
    "deposit",
    "--from",
    "GUSER",
    "--amount",
    "10000000",
  ]);

  const read = buildInvokeArgv({
    contractId: VAULT,
    method: "epoch",
    identity: "deployer",
    net: NET,
    args: {},
    readOnly: true,
  });
  assert.ok(read.includes("--send=no"));
  assert.equal(read.includes("--send=yes"), false);
});

test("a struct argument goes as JSON, with i128 fields as strings rather than floats", () => {
  const encoded = encodeArg({ epoch_duration: 604_800, min_fill: 1_000_000_000n });
  assert.equal(encoded, '{"epoch_duration":604800,"min_fill":"1000000000"}');
  // JSON.stringify alone throws on a bigint; that is the bug this encoder exists to not have.
  assert.throws(() => JSON.stringify({ x: 1n }), TypeError);
});

test("a non-integer contract argument is refused rather than rounded", () => {
  assert.throws(() => encodeArg(1.5), ChainError);
  assert.equal(encodeArg(true), "true");
  assert.equal(encodeArg(0), "0");
});

test("the contract id is found by shape, not by taking the last line on faith", () => {
  assert.equal(parseContractId(`deploying...\n${VAULT}\n`), VAULT);
  assert.equal(
    parseContractId(`ℹ️ using ${VAULT}\nsigned\n${VAULT}\n`),
    VAULT,
    "one id repeated is still one id",
  );
});

test("output holding two different ids is refused rather than guessed", () => {
  assert.throws(() => parseContractId(`${VAULT}\n${OTHER}\n`), /which\s+one was deployed is a guess/);
});

test("output holding no id is refused, and the refusal shows what the CLI printed", () => {
  assert.throws(
    () => parseContractId("error: account not found\n"),
    (e: unknown) => e instanceof ChainError && /account not found/.test(e.message),
  );
});

const TX1 = "e4266667e3e0887b117a30c31a310b81d7eda990249f9528f4fb6bfee1b271ee";
const TX2 = "5836a47a207f55feb0a717983fe1988e18856905ca0e8dc8845cc50fe366216e";
const WASM_HASH = "908dde6d80f16f3ccca3543c16e79e37a25c38dcda5cca1a10d5b68a258f3402";

test("a transaction hash is read from the CLI's label, and its absence reported as absence", () => {
  assert.equal(parseTxHash(`ℹ️  Signing transaction: ${TX1}\n✅ submitted`), TX1);
  assert.equal(parseTxHash("no hash here"), null);
  // A simulation submits nothing, so there is nothing to report.
  assert.equal(parseTxHash("ℹ️  Simulating transaction…\n1\n"), null);
  assert.equal(parseTxHash(VAULT), null);
});

test("a wasm hash is NOT mistaken for a transaction hash — it is 64 hex and comes FIRST", () => {
  // The real shape, measured 2026-08-20. A bare [0-9a-f]{64} match returns WASM_HASH here,
  // confidently and silently, and the deployment record then cites a hash no explorer can resolve.
  const out = [
    "ℹ️  Uploading contract WASM…",
    "ℹ️  Skipping install because wasm already installed",
    `ℹ️  Deploying contract using wasm hash ${WASM_HASH}`,
    `ℹ️  Signing transaction: ${TX1}`,
    "✅ Deployed!",
  ].join("\n");
  assert.deepEqual(parseTxHashes(out), [TX1]);
  assert.equal(parseTxHashes(out).includes(WASM_HASH), false);
});

test("one command is not one transaction: an upload and a create are both captured, in order", () => {
  const out = [
    "ℹ️  Uploading contract WASM…",
    `ℹ️  Signing transaction: ${TX1}`,
    `ℹ️  Deploying contract using wasm hash ${WASM_HASH}`,
    `ℹ️  Signing transaction: ${TX2}`,
    "✅ Deployed!",
  ].join("\n");
  assert.deepEqual(parseTxHashes(out), [TX1, TX2]);
  // Taking the first would record the upload as the deployment; taking the last would record
  // nothing on the runs where the wasm was already installed.
  assert.equal(skippedUpload(out), false);
});

test("the already-installed case is distinguishable, so the single hash can be labelled correctly", () => {
  assert.equal(skippedUpload("ℹ️  Skipping install because wasm already installed"), true);
  assert.equal(skippedUpload("ℹ️  Uploading contract WASM…"), false);
});

test("a value that looks like a flag is passed with = , or clap eats it as an option", () => {
  // Measured 2026-08-20: `--token_suffix -F` dies with "unexpected argument '-F' found", and every
  // fast-test and --experiment suffix is exactly that shape. Negative i128 arguments too.
  const argv = buildDeployArgv({
    wasmPath: "x.wasm",
    identity: "d",
    net: NET,
    constructorArgs: { token_suffix: "-F", deposit_cap: 5n },
  });
  const tail = argv.slice(argv.indexOf("--") + 1);
  assert.deepEqual(tail, ["--token_suffix=-F", "--deposit_cap", "5"]);
});

test("the = form is used only where the ambiguity is, so ordinary failures stay readable", () => {
  const argv = buildInvokeArgv({
    contractId: VAULT,
    method: "deposit",
    identity: "d",
    net: NET,
    args: { from: "GUSER", amount: -1n },
  });
  const tail = argv.slice(argv.indexOf("--") + 1);
  assert.deepEqual(tail, ["deposit", "--from", "GUSER", "--amount=-1"]);
});
