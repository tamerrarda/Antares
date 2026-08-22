# Responsive harnesses

Two pages that answer two different questions, plus the one rule that makes them necessary.

**Chrome on macOS refuses to open a window narrower than 500 px.** A `--window-size=375` screenshot
is therefore a 375-px *crop* of a 500-px layout, and every phone bug looks like it is not there.
This cost a wrong answer once already on the landing page. An iframe has no such floor, so both
pages below drive iframes and nothing here should be replaced by a narrow window.

They live outside `public/` on purpose — they are measurement tools, not part of the site — so they
have to be copied into the build output to share its origin. `pnpm --filter @antares/web
check:responsive` builds and copies; then serve `web/out` and open:

| page | question |
|---|---|
| `/overflow.html` | Is any page wider than its viewport? Six routes × five widths, measured as `scrollWidth − clientWidth`. Takes about three minutes: every route reads the chain, and a page measured while it still says "reading…" is a page whose real layout was never tested. |
| `/responsive.html#/rounds/` | How does one route look across four devices? |
| `/responsive.html#/,/claims/` | How do several routes look on one device? Add `?y=400` to scroll each frame. |

`overflow.html` answers *whether*; when it says yes, the element responsible is found by widening
the check in place — the previous version of this harness had a third page for that and it was used
exactly once, to find a `.pill` with `white-space: nowrap` inside a stacked table cell.
