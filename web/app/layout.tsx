import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "../components/SiteFooter.tsx";
import { SiteHeader } from "../components/SiteHeader.tsx";
import { WalletProvider } from "../components/useWallet.ts";
import "./globals.css";

/**
 * The tab icon, and why it is a generated PNG rather than the mark itself.
 *
 * `antares-mark-*.webp` is what the header draws, and it is the wrong file for this: it is
 * **not square** (192×218, and 48×55, and 96×109), so a browser fits it into a square slot by
 * squashing or letterboxing; and it is a near-white shape on transparency, so on a light tab strip
 * it is invisible. Declaring it with `sizes="48x48"` — which this file did for one commit — also
 * told the browser a size the image does not have.
 *
 * `favicon-32.png`, `favicon-192.png` and `apple-touch-icon.png` are square, opaque, and carry the
 * mark centred on `--void` (#05060a), which is the background it is drawn against everywhere else.
 * Generated once from `antares-mark-192.webp` with Pillow — square canvas, mark at 86 % and
 * centred — and committed, the same way `public/`'s other artwork is generated from sources kept
 * out of the repository.
 *
 * Written out with the base path rather than as `app/icon.png`, because a root-relative asset path
 * is not rewritten by `basePath`; the header and the footer carry the same prefix by hand and
 * `eslint.config.mjs` has a rule about it.
 */
const BASE = process.env["NEXT_PUBLIC_BASE_PATH"] ?? "";

export const metadata: Metadata = {
  title: "Antares",
  description: "A covered-call vault on Stellar. Unaudited, on testnet, and operated by nobody.",
  icons: {
    icon: [
      { url: `${BASE}/favicon-32.png`, sizes: "32x32", type: "image/png" },
      { url: `${BASE}/favicon-192.png`, sizes: "192x192", type: "image/png" },
    ],
    apple: { url: `${BASE}/apple-touch-icon.png`, sizes: "180x180", type: "image/png" },
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* One wallet state for the whole page: the header and the action panel are two readers of
            the same fact, and giving each its own hook meant connecting in one never reached the other. */}
        <WalletProvider>
          <div id="sky" />
          <SiteHeader />
          <div className="banner">
            <span>
              <b>Testnet.</b> No real funds.
            </span>
            <span>
              <b>Unaudited.</b> An internal review only.
            </span>
            <span>
              <b>The project runs a reference bidder</b> — it may be the counterparty to your round.
            </span>
          </div>
          <main>{children}</main>
          <SiteFooter />
        </WalletProvider>
      </body>
    </html>
  );
}
