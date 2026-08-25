import path from "node:path";
import { visit } from "unist-util-visit";

// Rewrite the relative `*.md` links the source tree uses into site routes.
//
// A naive "strip .md" is wrong, and quietly so. The source of a page lives at
// `docs/mechanism/auction.md` while its route is `/mechanism/auction/` — one
// directory deeper — so `../bidder/pricing.md` resolves against the *file* to
// `bidder/pricing.md` and against the *URL* to `/mechanism/bidder/pricing/`.
// Resolving against the file path and emitting an absolute route is the only
// version that agrees with both.
//
// Doing it here rather than in the Markdown is deliberate: the content tree stays
// navigable as plain Markdown — every link works when the files are read directly
// — and the site is correct as well, instead of one at the other's expense.
export default function rehypeDocsLinks({ docsRoot }) {
  const root = path.resolve(docsRoot);

  return (tree, file) => {
    const source = file?.path ? path.resolve(file.path) : null;
    if (!source || !source.startsWith(root)) return;
    const fromDir = path.dirname(path.relative(root, source));

    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      if (/^([a-z]+:|\/|#)/i.test(href)) return;

      const [target, hash] = href.split("#");
      if (!target.endsWith(".md")) return;

      const resolved = path
        .normalize(path.join(fromDir, target))
        .replace(/\\/g, "/")
        .replace(/\.md$/, "");

      const route = resolved === "index" ? "/" : `/${resolved.replace(/\/index$/, "")}/`;
      node.properties.href = hash ? `${route}#${hash}` : route;
    });
  };
}
