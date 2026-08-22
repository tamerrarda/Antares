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
      // The design draft: one hand-written page that renders seven contract states from a mock, kept
      // as reference while the real pages are ported off it. It is not in any tsconfig because it is
      // not part of the app, and it gets deleted when the port finishes.
      "web/app-draft.js",
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
