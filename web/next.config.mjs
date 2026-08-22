/**
 * `08-OFFCHAIN §3`: "App Router, static-first; chain reads via RPC from the client; **no backend of
 * record**." `output: "export"` is that sentence made enforceable — it fails the build on any
 * request-time server feature rather than letting one arrive by accident, which is the failure mode
 * that matters here: a page that quietly starts depending on a server we run is a trust claim
 * silently withdrawn.
 *
 * The consequence is real and is designed around elsewhere: a static build cannot learn about a
 * contract deployed after it was built (`lib/deployment.ts`), and cannot see an evidence index
 * committed after it was built — which is why the Claims page reads the chain first and treats the
 * index as the fallback.
 */
/**
 * The network is a build input, not a default.
 *
 * `packages/common/networks.ts` refuses to guess and says why — "a default is how a tool ends up
 * pointed at the wrong network without saying so" — and a browser has no `process.env` to read at
 * runtime, so the value has to be baked in. Asserting it here means a mis-configured build fails at
 * build time; without this it succeeded and shipped a page that explained the misconfiguration to
 * visitors instead, which is the same bug discovered by the wrong person.
 */
const NETWORK = process.env.NEXT_PUBLIC_NETWORK;
if (!NETWORK) {
  throw new Error(
    "NEXT_PUBLIC_NETWORK is not set. Set it to `testnet` or `mainnet` before building — see web/.env.example.",
  );
}

const config = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  eslint: { ignoreDuringBuilds: true },
};

export default config;
