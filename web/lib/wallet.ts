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

/**
 * Detection has to be bounded, because absence does not answer.
 *
 * Measured 2026-08-22 in a Chrome with no Stellar wallet: `isConnected()` posts a message to a
 * content script that is not there and the promise never settles. The button that called it sat on
 * "Connecting…" for as long as the page was open, with no error and no way back — a visitor without
 * a wallet pressing the one button on the page and getting a permanent lock.
 *
 * An installed extension replies in milliseconds, so a short bound costs nothing and turns a hang
 * into a sentence.
 */
const DETECT_MS = 2500;

/**
 * And every interactive call needs a bound too, which is the sharper half of the same bug.
 *
 * Freighter's own transport gives `isConnected` a two-second timeout and gives `requestAccess`
 * **none**. So a wallet that answers the detection probe and then goes quiet — locked, crashed,
 * mid-update, or an extension that speaks half the protocol — leaves the promise open forever.
 * Found by pressing the button in a browser where exactly that happens: the page sat on
 * "Connecting…" indefinitely with no error and no way back.
 *
 * These bounds are long on purpose. A real prompt waits on a human reading it, so the failure being
 * caught here is a wallet that will never answer, not a user who is slow.
 */
const INTERACT_MS = 60_000;
const SIGN_MS = 180_000;

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function orGiveUp<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Your wallet did not answer within ${Math.round(ms / 1000)} seconds while ${what}. It may ` +
                "be locked, or it may have been interrupted — opening the extension and unlocking it " +
                "usually clears this. Nothing was sent and nothing was signed.",
            ),
          ),
        ms,
      ),
    ),
  ]);
}

export async function available(): Promise<boolean> {
  try {
    const r = await withTimeout(isConnected(), DETECT_MS, { isConnected: false });
    return "isConnected" in r && r.isConnected;
  } catch {
    return false;
  }
}

/** Opens the extension's own approval prompt. The user grants access there, never here. */
export async function connect(): Promise<string> {
  return unwrap(await orGiveUp(requestAccess(), INTERACT_MS, "asking for access"), "Freighter refused access")
    .address;
}

/** The already-granted address, or a throw if nothing has been granted yet. */
export async function currentAddress(): Promise<string> {
  return unwrap(
    await orGiveUp(getAddress(), INTERACT_MS, "reading your address"),
    "Could not read the address",
  ).address;
}

/**
 * The passphrase the wallet is actually on.
 *
 * Read separately from the address and compared against the one this build was compiled for. A
 * wallet on the wrong chain does not fail loudly — it signs happily against a contract id that
 * means nothing there, and the failure arrives with a reason unrelated to anything the user did.
 */
export async function currentNetwork(): Promise<string> {
  return unwrap(
    await orGiveUp(getNetwork(), INTERACT_MS, "reading which network it is on"),
    "Could not read the wallet's network",
  ).networkPassphrase;
}

/** Signs, and nothing more. Submission is the caller's, so the two can be reported separately. */
export async function sign(xdr: string, networkPassphrase: string, address: string): Promise<string> {
  const out = unwrap(
    await orGiveUp(
      signTransaction(xdr, { networkPassphrase, address }),
      SIGN_MS,
      "waiting for your signature",
    ),
    "Signing was refused",
  );
  return out.signedTxXdr;
}
