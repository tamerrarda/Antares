/**
 * The three destinations that live outside this app, in one place.
 *
 * They appear in two surfaces — the app's footer and the landing page — and a link that is right
 * in one and stale in the other is worse than no link, so the app reads them from here and the
 * landing page's copy is checked against this file by `scripts/ci/static_rules.py`.
 *
 * `FEEDBACK` is deliberately empty. The form does not exist yet, and a `#` href is a link that
 * lies: it looks like a destination and is a no-op. While the string is empty the control renders
 * as disabled and says so; filling it in turns the control into a real link with no other change.
 */

/** The docs site. Source lives in this repository under `site/`; it publishes from `AntaresDocs`. */
export const DOCS = "https://docsantares.vercel.app/";

/** The repository the contract, the keeper, this interface and the docs source all live in. */
export const REPO = "https://github.com/tamerrarda/Antares";

/** Empty until the form exists. See the note above before replacing it with a placeholder. */
export const FEEDBACK = "";
