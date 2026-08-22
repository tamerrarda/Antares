import Link from "next/link";

/** The verify column is the product's argument, so it comes before the reading column. */
export function SiteFooter() {
  return (
    <footer>
      <div className="foot-in">
        <div>
          <div className="foot-brand">
            <img src="/antares-mark-96.webp" alt="" width={22} height={25} />
            <span>ANTARES</span>
          </div>
          <p className="said">
            A covered-call vault on Stellar. <b>Unaudited, on testnet, and run by nobody</b> — rounds open and
            close because someone calls them, and that someone can be you.
          </p>
          <p className="said">
            Apache-2.0. The contract, the keeper and this interface are all in one public repository.
          </p>
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
              <a href="#">Vault contract on stellar.expert ↗</a>
            </li>
            <li>
              <a href="#">Oracle adapter on stellar.expert ↗</a>
            </li>
          </ul>
        </div>
        <div>
          <h4>Read</h4>
          <ul>
            <li>
              <a href="#">If you are depositing ↗</a>
            </li>
            <li>
              <a href="#">If you are bidding ↗</a>
            </li>
            <li>
              <a href="#">Trust model — what can go wrong ↗</a>
            </li>
            <li>
              <a href="#">Known issues ↗</a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
