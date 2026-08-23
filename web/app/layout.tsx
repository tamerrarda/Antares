import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "../components/SiteFooter.tsx";
import { SiteHeader } from "../components/SiteHeader.tsx";
import { WalletProvider } from "../components/useWallet.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Antares",
  description: "A covered-call vault on Stellar. Unaudited, on testnet, and operated by nobody.",
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
