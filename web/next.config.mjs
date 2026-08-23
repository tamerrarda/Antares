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

/**
 * The app lives under `/app` on the same origin as the landing page, and that is a security choice
 * rather than a layout one.
 *
 * Antares' whole posture is "do not trust us, verify". Teaching a user that the app lives on a
 * *different* host from the site they arrived at is teaching them to accept a domain switch — and
 * `app-antares.example` then looks exactly as legitimate as the real thing. Same origin means the
 * domain never changes on the way in, so any domain that does change is wrong. Wallet permissions
 * are origin-scoped, which pushes the same way.
 *
 * Exported here rather than hard-coded at the two call sites that need it: `basePath` rewrites
 * `<Link>` and `next/image`, but **not** a raw `<img src="/...">`, and both header and footer use
 * one. `NEXT_PUBLIC_BASE_PATH` is how they reach the same value.
 */
const BASE_PATH = "/app";

const config = {
  output: "export",
  basePath: BASE_PATH,
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  images: { unoptimized: true },
  trailingSlash: true,
  eslint: { ignoreDuringBuilds: true },
};

export default config;
