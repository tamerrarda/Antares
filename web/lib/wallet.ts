/**
 * The wallet, behind one door — and the door is the point.
 *
 * `08-OFFCHAIN §3` names Stellar Wallets Kit. Measured on 2026-08-22 it costs **537 packages**, ten
 * of which demand postinstall scripts — including `usb` and `secp256k1`, native modules pulled in
 * for Ledger and WalletConnect transports that a browser bundle never loads — and pnpm 11.1.2
 * refuses to run any workspace script until each is approved. For a project whose D-24 turned down
 * an audited dependency to keep "zero supply-chain risk and full audit-scope control", spending
 * that on a connect button is the wrong trade at this stage.
 *
 * So this is Freighter directly: **one** package, no native code, and the wallet essentially every
 * Stellar testnet user already has. What makes the choice cheap to reverse is that nothing outside
 * this file knows about it — `useWallet` consumes the four functions below and nothing else, so
 * adopting the kit later is one module rather than a refactor.
 *
 * Dynamically imported by its caller: this reaches for the injected extension, and the app is a
 * static export whose pages are rendered in Node at build time.
 */
import { getAddress, getNetwork, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

/** Freighter returns `{ error }` in the value rather than throwing. Normalise once, here. */
function unwrap<T extends object>(result: T | { error: string }, what: string): T {
  if ("error" in result && typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`${what}: ${result.error}`);
  }
  return result as T;
}

export async function available(): Promise<boolean> {
  try {
    const r = await isConnected();
    return "isConnected" in r && r.isConnected;
  } catch {
    return false;
  }
}

/** Opens the extension's own approval prompt. The user grants access there, never here. */
export async function connect(): Promise<string> {
  return unwrap(await requestAccess(), "Freighter refused access").address;
}

/** The already-granted address, or a throw if nothing has been granted yet. */
export async function currentAddress(): Promise<string> {
  return unwrap(await getAddress(), "Could not read the address").address;
}

/**
 * The passphrase the wallet is actually on.
 *
 * Read separately from the address and compared against the one this build was compiled for. A
 * wallet on the wrong chain does not fail loudly — it signs happily against a contract id that
 * means nothing there, and the failure arrives with a reason unrelated to anything the user did.
 */
export async function currentNetwork(): Promise<string> {
  return unwrap(await getNetwork(), "Could not read the wallet's network").networkPassphrase;
}

/** Signs, and nothing more. Submission is the caller's, so the two can be reported separately. */
export async function sign(xdr: string, networkPassphrase: string, address: string): Promise<string> {
  const out = unwrap(await signTransaction(xdr, { networkPassphrase, address }), "Signing was refused");
  return out.signedTxXdr;
}
