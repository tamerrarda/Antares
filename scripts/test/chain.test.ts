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

test("a transaction hash is recognised and its absence is reported as absence", () => {
  const h = "a".repeat(64);
  assert.equal(parseTxHash(`tx ${h} succeeded`), h);
  assert.equal(parseTxHash("no hash here"), null);
  // A contract id is not a transaction hash, and base32 must not be mistaken for hex.
  assert.equal(parseTxHash(VAULT), null);
});
