import Link from "next/link";

import { deployment, instances } from "../lib/deployment.ts";
import { vaultName } from "../lib/vault-name.ts";
import { DOCS, FEEDBACK, REPO as REPO_ROOT } from "../lib/links.ts";

/**
 * The repository the contract, the keeper and this interface all live in.
 *
 * The four documents below are files in it — `docs/DEPOSITOR.md` and its siblings — rather than
 * pages on a site that does not exist yet. They were `#` until now, which is a link that lies:
 * it looks like a destination and is a no-op. Pointing them at the real paths makes them true the
 * moment the repository is public, which is the same moment this interface is.
 */
const REPO = `${REPO_ROOT}/blob/main`;

/** The verify column is the product's argument, so it comes before the reading column. */
export function SiteFooter() {
  const d = deployment();
  const explorer = (id: string) => `https://stellar.expert/explorer/${d.network}/contract/${id}`;
  /**
   * Every vault, not the first one.
   *
   * This column said "Vault contract on stellar.expert" and linked `instances[0]` — correct while
   * one vault existed and quietly wrong from the morning three did, because the footer is on every
   * page and cannot know which one a reader is looking at. Naming each by its terms is the version
   * that stays true as the set grows, and a single-vault deployment reads exactly as it did before.
   */
  const vaults = instances();
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
            {vaults.map((v) => (
              <li key={v.tokenSuffix}>
                <a href={explorer(v.vaultId)} target="_blank" rel="noreferrer">
                  {vaults.length === 1
                    ? "Vault contract on stellar.expert"
                    : `${vaultName(v.epochDuration, v.strikeBpsOtm)} vault on stellar.expert`}{" "}
                  ↗
                </a>
              </li>
            ))}
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

      {/* The three destinations outside this app, on one line under everything else. Feedback has
          no form yet: rather than a `#` that looks like a destination and does nothing, it renders
          as a disabled control that says why, and becomes a link the moment `FEEDBACK` is set. */}
      <div className="foot-bar">
        <a href={DOCS} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <a href={REPO_ROOT} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
        {FEEDBACK ? (
          <a href={FEEDBACK} target="_blank" rel="noreferrer">
            Feedback ↗
          </a>
        ) : (
          <span aria-disabled="true" title="Not open yet">
            Feedback
          </span>
        )}
      </div>
    </footer>
  );
}
