"use client";

import Link from "next/link";

import { useFleet } from "../../components/useFleet.ts";
import { amount } from "../../lib/format.ts";
import { capLabel, lengthLabel, vaultName } from "../../lib/vault-name.ts";

export default function ComparePage() {
  const { rows, loading } = useFleet(null);

  return (
    <>
      <div className="head">
        <div>
          <h1>
            {rows.length > 1 ? `${rows.length} vaults, one experiment` : "One vault, four still to come"}
          </h1>
          <div className="phase" data-tone="quiet" style={{ marginTop: 14 }}>
            <span style={{ maxWidth: "78ch" }}>
              They differ in two things only. Everything else — the code, the oracle, the auction — is
              identical.
            </span>
          </div>
        </div>
      </div>

      <article className="card">
        <h2>
          <span>How they differ</span>
          <em>{loading ? "reading the chain…" : "read from the deployment record, not from a plan"}</em>
        </h2>
        <div className="fleet">
          {rows.map((r, i) => (
            <div key={r.instance.vaultId} {...(i === 0 ? { "data-default": "" } : {})}>
              <h3>{vaultName(r.instance.epochDuration, r.instance.strikeBpsOtm)}</h3>
              <span className="muted">
                {r.instance.tokenSuffix.replace("-", "instance ")}
                {i === 0 && " · default"}
                {r.instance.economicallyMeaningless && " · fast-test"}
              </span>
              <dl>
                <dt>Your money is committed for</dt>
                <dd>{lengthLabel(r.instance.epochDuration)}</dd>
                <dt>You keep the gain</dt>
                <dd>{capLabel(r.instance.strikeBpsOtm)}</dd>
                <dt>Deposit cap</dt>
                <dd>{amount(r.instance.depositCap, 0)} XLM</dd>
              </dl>
              {r.instance.economicallyMeaningless && (
                <p className="why">
                  A fast-test profile. Its rounds last {lengthLabel(r.instance.epochDuration)} instead of a
                  week, so it exercises the machinery and its numbers can never be read as evidence that
                  anyone wants these terms.
                </p>
              )}
              {i !== 0 && (
                <Link className="switch" href="/" style={{ textDecoration: "none" }}>
                  Join the experiment
                </Link>
              )}
            </div>
          ))}
        </div>
      </article>

      <article className="card">
        <h2>
          <span>What the two axes actually mean</span>
        </h2>
        <div className="payoff">
          <div>
            <span className="k">How long your money is committed</span>
            <b>The length of one round, plus a window at the end of it.</b>
            <p>
              You can queue an exit at any moment; the length decides how long you wait for it to pay. Between
              rounds there is a window — at least{" "}
              {rows[0] === undefined ? "a few hours" : lengthLabel(rows[0].instance.minIdleGap)} — in which
              exits are instant.
            </p>
          </div>
          <div>
            <span className="k">How far the price can rise before you stop keeping the gain</span>
            <b>The cap, set fresh at the start of every round from the price at that moment.</b>
            <p>
              Below it you keep everything and the premium on top. Above it the vault pays the difference in
              cash — nothing is delivered and nothing is sold.
            </p>
          </div>
        </div>
      </article>

      {rows.length < 5 && (
        <article className="card">
          <h2>
            <span>The experiment this page is meant to show</span>
          </h2>
          <div className="body">
            <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
              Phase 2 deploys five instances concurrently and asks which terms attract a buyer — the point
              being the <b>shape of the response surface</b> over duration and cap, not any one vault&apos;s
              result. A single silence tells you nothing; five simultaneous silences across the plausible
              parameter space is a finding.
            </p>
            <p className="sub" style={{ maxWidth: "82ch" }}>
              {rows.length === 1 ? "One instance is" : `${rows.length} instances are`} deployed today. This
              page lists what the deployment record contains and nothing else: four cards drawn from a
              planning table would look like a product and be a promise.
            </p>
          </div>
        </article>
      )}
    </>
  );
}
