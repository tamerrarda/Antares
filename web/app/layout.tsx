import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "../components/SiteFooter.tsx";
import { SiteHeader } from "../components/SiteHeader.tsx";
import { WalletProvider } from "../components/useWallet.ts";
import "./globals.css";

/**
 * The mark, at the three sizes `public/` carries.
 *
 * Written out with the base path rather than as `app/icon.webp`, for two reasons that both bite.
 * Next's file convention does not accept `.webp` — `.ico`, `.png`, `.jpg` and `.svg` only — and the
 * mark exists here as webp. And a bare `/antares-mark-96.webp` is a root-relative asset path, which
 * `basePath` does not rewrite; the header and the footer already carry the same prefix by hand for
 * the same reason, and `eslint.config.mjs` has a rule about it.
 *
 * The landing page and the docs site both had a tab icon and the app had none, which is the surface
 * a depositor keeps open.
 */
const ICON = `${process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""}/antares-mark-96.webp`;
const ICON_LARGE = `${process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""}/antares-mark-192.webp`;
const ICON_SMALL = `${process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""}/antares-mark-48.webp`;

export const metadata: Metadata = {
  title: "Antares",
  description: "A covered-call vault on Stellar. Unaudited, on testnet, and operated by nobody.",
  icons: {
    icon: [
      { url: ICON_SMALL, sizes: "48x48", type: "image/webp" },
      { url: ICON, sizes: "96x96", type: "image/webp" },
      { url: ICON_LARGE, sizes: "192x192", type: "image/webp" },
    ],
    apple: ICON_LARGE,
  },
};

/**
 * The disclosure bar is permanent and not dismissible — 08-OFFCHAIN §3 puts it in the page rather
 * than in a toast, and the reference-bidder line is the one a reader is least likely to guess and
 * most entitled to know: the project may be the counterparty to its own user's round.
 */
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
