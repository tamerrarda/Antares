"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { WalletCorner } from "./WalletCorner.tsx";

/**
 * The four destinations are 08-OFFCHAIN §3's four pages, in the order a depositor meets them.
 *
 * The operator log is deliberately NOT here. It is reachable from the config card on the Vault page
 * — where somebody asking "what can the operator do" is already looking — and from the footer. Five
 * items is one more than a phone header holds, and the one that goes is the page nobody navigates
 * to on purpose.
 */
const PAGES = [
  ["/", "Vault"],
  ["/rounds/", "Rounds"],
  ["/claims/", "Claims"],
  ["/positions/", "My positions"],
] as const;

export function SiteHeader() {
  const here = usePathname();
  return (
    <header>
      <Link className="brand" href="/">
        <img
          src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/antares-mark-96.webp`}
          alt=""
          width={26}
          height={30}
        />
        <span>ANTARES</span>
      </Link>
      <nav>
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href} {...(here === href ? { "aria-current": "page" as const } : {})}>
            {label}
          </Link>
        ))}
      </nav>
      <WalletCorner />
    </header>
  );
}
