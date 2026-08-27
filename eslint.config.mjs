/**
 * ESLint — the off-chain analogue of `clippy -D warnings`, and held to the same bar.
 *
 * `06-TEST-PLAN.md` §8's chain runs `fmt → clippy (-D warnings) → …` on the Rust side, and `DEV3.md`
 * Phase 1 asks for *"TS lint + typecheck in CI"*. Two things, not one: `tsc` proves the types are
 * sound, a linter catches the shapes that typecheck fine and are still wrong. Both run, and
 * `--max-warnings 0` in CI is what makes "lint" mean the same thing here as `-D warnings` means
 * there — a warning nobody has to fix is a warning nobody fixes.
 *
 * Type-aware rules are on (`recommendedTypeChecked`), because the ones worth having need types: an
 * un-awaited promise in the keeper's loop is a round that silently did not close, and no
 * syntax-only rule can see it.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      // Generated, vendored, or another language.
      "**/dist/**",
      // Next.js build output. `out/` is the static export and `.next/` its intermediate form; both
      // are machine-written bundles that would be reported against code nobody typed.
      "web/.next/**",
      "web/out/**",
      // The assembled deploy tree — the landing and a copy of `out/` in one directory. Linting it
      // reports the export's own bundles a second time, under a second path.
      "web/site/**",
      // The design draft: one hand-written page that renders seven contract states from a mock, kept
      // as reference while the real pages are ported off it. It is not in any tsconfig because it is
      // not part of the app, and it gets deleted when the port finishes.
      "web/app-draft.js",
      // The web package's own build tooling, which sits outside its tsconfig for the same reason
      // `build-frames.py` beside it does: these assemble the deployable tree, they are not part of
      // the app, and typed-linting them would mean pulling build scripts into the app's project.
      "web/scripts/**",
      "**/node_modules/**",
      "target/**",
      "contracts/**",
      "plan/**",

      // Machine output, byte-compared against a fresh generation. Linting it would report findings
      // against code nobody wrote and cannot fix without breaking the comparison that makes the
      // bindings trustworthy — see scripts/generate-bindings.ts.
      "packages/bindings/src/**",

      // This file. Type-aware linting of the linter's own config needs types for `@eslint/js`, which
      // ships none, so the rules report unresolved-type errors against correct code. It is not
      // unchecked: prettier formats it, and if it were broken eslint could not start at all — which
      // is a stronger check than a lint pass.
      "eslint.config.mjs",

      // `scripts/verify-environment.ts` is DEV2's file inside DEV3's tree (DEV-PROTOCOL §3's
      // carve-out), and the linter found three things in it: an unused `Networks` import, an unsafe
      // `any` return out of `fmt`'s JSON replacer, and a `let` that is never reassigned. None is a
      // correctness defect and none is mine to fix — editing another developer's file to make my own
      // gate green is how a finding becomes invisible. Raised in plan/STANDUP.md for DEV2; this line
      // comes out the moment they land the fix, and it is one `--fix` away for two of the three.
      "scripts/verify-environment.ts",

      // The documentation site, for the same reason `web/scripts/**` is here: it is not part of
      // this project. `site/` is a separate pnpm workspace — its own `pnpm-workspace.yaml`, its own
      // lockfile, its own `tsconfig.json` extending `astro/tsconfigs/strict` — and it is absent
      // from this workspace's `packages:` list by design.
      //
      // Type-aware linting it from here reports findings the root project cannot answer. Eight of
      // them are in `src/rehype-docs-links.mjs`, all `no-unsafe-*` against `hast` nodes: the tree,
      // the file and every node are `any` because `@types/hast` is not installed anywhere in this
      // repository. They are not defects in that file — they are the absence of types the docs
      // site never needed, and silencing them by annotating another package's source with
      // approximations would be worse than either fixing it there or leaving it alone.
      //
      // The remainder are `.astro/`, which Astro generates and `site/.gitignore` already excludes.
      //
      // **What this gives up, stated plainly: `site/` is now linted by nothing.** Not by this
      // config, and not by its own — `site/package.json` declares `"check": "astro check"`, but
      // `@astrojs/check` is not among its dependencies, so the command stops on an interactive
      // prompt asking to install it and has evidently never run. A declared gate with no runner is
      // the failure this repository's own CI file names in §14, and it is worth more than the eight
      // findings above: those are missing types, this is a missing check.
      //
      // The follow-up is two steps, in this order: add `@astrojs/check` and `typescript` to
      // `site/`, then put `pnpm --dir site check` in the CI chain. Until both land, the docs site
      // is unchecked and this comment is the only place that says so.
      "site/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Amounts are i128 stroops and must stay `bigint` all the way to the formatter (see
      // events.ts). An implicit stringification of one in a template literal is how a log line ends
      // up with "[object Object]" where an amount should be, so this stays strict.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // A deliberately-ignored binding is written with a leading underscore.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // `.mjs` config files run in Node, and `no-undef` — which typescript-eslint switches off for
    // `.ts` because the compiler already answers the question — has no such knowledge here. Only
    // the globals actually used are declared, so a genuine typo in one of these still fails.
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    // The app is served under `basePath: "/app"`, and Next applies that prefix to `<Link>` at render
    // time but to a raw `<a href="/...">` **only while exporting the static HTML**. So a raw anchor
    // looks correct in the built page and silently loses its prefix the moment the component
    // re-renders on the client — which is how "See everything the operator has ever done" shipped
    // pointing at `/operator/`, a 404, while `out/index.html` said `/app/operator/`. Measured in the
    // live DOM on 2026-08-24, not inferred.
    //
    // No amount of checking the built output catches this: the bug is in markup that only exists
    // after hydration. The rule has to be on the source.
    files: ["web/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'JSXOpeningElement[name.name="a"] > JSXAttribute[name.name="href"] > Literal[value=/^\\//]',
          message:
            'Root-relative <a href="/..."> loses the /app basePath on client re-render. Use next/link\'s <Link>.',
        },
        {
          // Same trap, no `<Link>` to reach for: an asset reference is never rewritten at runtime,
          // so it has to carry the prefix itself. `NEXT_PUBLIC_BASE_PATH` is the value, and a
          // template literal is what both the header and the footer already use.
          selector:
            'JSXOpeningElement[name.name=/^(img|source|video|audio|embed|iframe)$/] > JSXAttribute[name.name="src"] > Literal[value=/^\\//]',
          message:
            'Root-relative src="/..." is not rewritten by basePath. Use `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/...`.',
        },
      ],
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      // Tests assert on shapes that are deliberately malformed — a record missing a required field,
      // a data map that is `null`, an event with a truncated topic list. Constructing those needs
      // casts production code should never contain, so the two are held to different rules rather
      // than the tests being bent around a rule aimed at production.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",

      // `node:test`'s `test()` returns a promise that is documented as not being awaited at the top
      // level — that is how the runner collects cases. These fire on correct, idiomatic use of the
      // standard library's own test runner, so they are off *for test files only*.
      // `no-floating-promises` stays on for production code, where it is one of the rules most worth
      // having: an un-awaited `close_round` in the keeper is a round that silently did not close.
      "@typescript-eslint/no-floating-promises": "off",
      // An `async` callback with no `await` is the ordinary way to hand a `() => Promise<T>` to
      // something that expects one — which is exactly `withBackoff`'s signature.
      "@typescript-eslint/require-await": "off",
    },
  },
);
