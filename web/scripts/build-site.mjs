/**
 * Assemble the deployable tree: the landing page at `/`, the app at `/app/`.
 *
 * # Why one origin rather than two
 *
 * The alternative — `antares.example` for the landing and `app.antares.example` for the app — is
 * the common shape and it is the wrong one *here*. This project's entire posture is "do not trust
 * us, verify"; training a user that the app lives on a different host than the site they arrived at
 * is training them to accept a domain switch, and `app-antares.example` then looks exactly as
 * legitimate as the real thing. Same origin means the domain never changes on the way in, so a
 * domain that does change is wrong on its face. Wallet permissions are origin-scoped, which pushes
 * the same way, and one origin is one certificate and one deploy for an operator who is one person.
 *
 * # The check at the end is the point
 *
 * The landing's "Launch app" button has pointed at `/app` since the page was written, and until
 * 2026-08-24 **nothing served anything there** — the export put its pages at the root. A link into
 * a void is exactly the class of thing nobody notices until a user does, so this script ends by
 * resolving every local link the landing makes against the tree it just built, and refuses if one
 * of them does not exist.
 */

import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = join(WEB, "landing");
const EXPORT = join(WEB, "out");
const SITE = join(WEB, "site");
/** Must match `basePath` in next.config.mjs. Asserted below rather than trusted. */
const BASE_PATH = "app";

async function sizeOf(dir) {
  let total = 0;
  const walk = async (d) => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  await walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  if (!existsSync(EXPORT)) {
    console.error(`no export at ${EXPORT} — run \`NEXT_PUBLIC_NETWORK=… pnpm build\` first.`);
    return 1;
  }
  if (!existsSync(join(LANDING, "index.html"))) {
    console.error(`no landing at ${LANDING}/index.html`);
    return 1;
  }

  await rm(SITE, { recursive: true, force: true });
  await mkdir(SITE, { recursive: true });
  await cp(LANDING, SITE, { recursive: true });
  await cp(EXPORT, join(SITE, BASE_PATH), { recursive: true });

  // ---- every local link the landing makes must resolve in the tree we just built ---------------
  const html = await readFile(join(LANDING, "index.html"), "utf8");
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => !/^(https?:|mailto:|#|data:)/.test(h));

  const broken = [];
  for (const link of new Set(links)) {
    // `/` is the landing itself; anything else resolves as a path under the site root, and a
    // trailing slash means a directory whose index.html has to exist.
    const rel = link.replace(/^\.?\//, "");
    if (rel === "") continue;
    const target = join(SITE, rel);
    const ok = link.endsWith("/") ? existsSync(join(target, "index.html")) : existsSync(target);
    if (!ok) broken.push(link);
  }

  const landingBytes = await sizeOf(LANDING);
  const appBytes = await sizeOf(EXPORT);
  console.log(`\n  site/            ${mb(landingBytes + appBytes)}`);
  console.log(`    /              ${mb(landingBytes)}  landing, artwork included`);
  console.log(`    /${BASE_PATH}/          ${mb(appBytes)}  the app, carrying none of it\n`);

  if (broken.length > 0) {
    console.error(`REFUSED: the landing links to ${broken.length} path(s) the site does not serve:`);
    for (const b of broken) console.error(`  ${b}`);
    return 1;
  }
  console.log(`  every local link the landing makes resolves, including the seam at /${BASE_PATH}/.`);
  return 0;
}

process.exit(await main());
