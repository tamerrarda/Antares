/**
 * Structured logging, and the one rule that makes it safe to leave on.
 *
 * `08-OFFCHAIN.md` §1 lists logging as a shared piece and puts `WrongPhase` at debug; `07-SECURITY.md`
 * §6 governs what may be written down. The keeper runs unattended for days, so its log is the only
 * account of what happened — and the only artefact an operator reads after an incident.
 *
 * **Nothing here ever logs a secret, and that is enforced rather than intended.** Every record goes
 * through {@link scrub}, which drops values under keys that name credentials. The keeper and the
 * bidder run on **throwaway testnet identities that are never in git** (`DEV3.md` §6.1,
 * `07-SECURITY.md` §6), and a log line is the easiest way for a key to leave the machine anyway:
 * logs get pasted into issues, attached to standups, and shipped to webhooks. An allowlist would be
 * safer still, but it makes every new field invisible by default, and a log that silently omits the
 * field you needed is its own failure.
 */

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

const ORDER: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Key substrings whose values are replaced with `"[redacted]"`, matched case-insensitively.
 *
 * `identity` is here alongside the obvious ones because `stellar keys` calls a key alias an
 * "identity", and the word reads harmless in a field name.
 */
const REDACT_KEY_PATTERNS = [
  "secret",
  "seed",
  "privatekey",
  "private_key",
  "password",
  "token",
  "identity",
  "signature",
  "mnemonic",
];

/** A stroop amount rendered as XLM for a human, without ever going through a float. */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac === "" ? "" : `.${frac}`}`;
}

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively replace credential-shaped values and make the record JSON-safe.
 *
 * `bigint` is handled explicitly because `JSON.stringify` throws on it rather than degrading, and a
 * logger that throws while reporting an error loses the error. Amounts are emitted as decimal
 * strings, never as `number`: a stroop value above 2^53 would be silently wrong, and the log is the
 * evidence trail (`08-OFFCHAIN.md` §1).
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[too deep]";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = shouldRedact(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  readonly level?: Level;
  /** Emitted on every line — the keeper sets `{ instance: "aXLM-A" }` so five vaults stay separable. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Injected for tests. Receives one JSON line, without a trailing newline. */
  readonly sink?: (line: string) => void;
  /** Injected for tests, so a line's shape can be asserted byte-for-byte. */
  readonly now?: () => string;
}

export class Logger {
  readonly #level: Level;
  readonly #context: Readonly<Record<string, unknown>>;
  readonly #sink: (line: string) => void;
  readonly #now: () => string;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? (process.env["LOG_LEVEL"] as Level | undefined) ?? "info";
    if (!LEVELS.includes(this.#level)) {
      throw new RangeError(`unknown log level "${this.#level}"; known: ${LEVELS.join(", ")}`);
    }
    this.#context = options.context ?? {};
    this.#sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** A child logger carrying extra context — one per vault instance in the keeper's loop. */
  child(context: Readonly<Record<string, unknown>>): Logger {
    return new Logger({
      level: this.#level,
      context: { ...this.#context, ...context },
      sink: this.#sink,
      now: this.#now,
    });
  }

  log(level: Level, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (ORDER[level] < ORDER[this.#level]) return;
    const record = {
      ts: this.#now(),
      level,
      msg: message,
      ...(scrub({ ...this.#context, ...fields }) as Record<string, unknown>),
    };
    this.#sink(JSON.stringify(record));
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("debug", message, fields);
  }
  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("info", message, fields);
  }
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("warn", message, fields);
  }
  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log("error", message, fields);
  }
}
