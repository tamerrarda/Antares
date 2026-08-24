import Link from "next/link";

import { deployment } from "../lib/deployment.ts";

/**
 * The repository the contract, the keeper and this interface all live in.
 *
 * The four documents below are files in it — `docs/DEPOSITOR.md` and its siblings — rather than
 * pages on a site that does not exist yet. They were `#` until now, which is a link that lies:
 * it looks like a destination and is a no-op. Pointing them at the real paths makes them true the
 * moment the repository is public, which is the same moment this interface is.
 */
const REPO = "https://github.com/tamerrarda/Antares/blob/main";

/** The verify column is the product's argument, so it comes before the reading column. */
export function SiteFooter() {
  const d = deployment();
  const explorer = (id: string) => `https://stellar.expert/explorer/${d.network}/contract/${id}`;
  return (
    <footer>
      <div className="foot-in">
        <div>
          <div className="foot-brand">
            <img
              src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/antares-mark-96.webp`}
              alt=""
              width={22}
              height={25}
            />
            <span>ANTARES</span>
          </div>
          <p className="said">
            A covered-call vault on Stellar. <b>Unaudited, on testnet, and run by nobody</b> — anyone opens
            and closes its rounds, including you.
          </p>
          <p className="said">Apache-2.0. Contract, keeper and interface in one repository.</p>
        </div>
        <div>
          <h4>Verify</h4>
          <ul>
            <li>
              <Link href="/operator/">Operator log — every admin action</Link>
            </li>
            <li>
              <Link href="/rounds/">Round history</Link>
            </li>
            <li>
              <a href={explorer(d.vaultId)} target="_blank" rel="noreferrer">
                Vault contract on stellar.expert ↗
              </a>
            </li>
            <li>
              <a href={explorer(d.oracleId)} target="_blank" rel="noreferrer">
                Oracle adapter on stellar.expert ↗
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h4>Read</h4>
          <ul>
            <li>
              <a href={`${REPO}/docs/DEPOSITOR.md`} target="_blank" rel="noreferrer">
                If you are depositing ↗
              </a>
            </li>
            <li>
              <a href={`${REPO}/docs/BIDDER.md`} target="_blank" rel="noreferrer">
                If you are bidding ↗
              </a>
            </li>
            <li>
              <a href={`${REPO}/docs/TRUST_MODEL.md`} target="_blank" rel="noreferrer">
                Trust model — what can go wrong ↗
              </a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
