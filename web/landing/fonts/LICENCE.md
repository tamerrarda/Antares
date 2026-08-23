# Departure Mono

- **Designer:** Helena Zhang — https://helenazhang.com
- **Version:** 1.500
- **Source:** https://github.com/rektdeckard/departure-mono — release `v1.500`, downloaded 2026-08-21
- **Licence:** SIL Open Font License 1.1. The full text is in `DepartureMono-LICENSE.txt`, and the
  font binary carries it internally as well (name ID 13), so the permission travels with the file
  rather than with a page that linked to it.

## Why this and not VCR OSD Mono

VCR OSD Mono was fetched first and dropped after measuring it. Two reasons, and the second is the
one that decided it:

1. **Provenance.** Its only licence statement was dafont's "100% Free" *category* — a distributor's
   label. The binary carried no licence string and the archive had no readme. Departure Mono ships
   an OFL text file and embeds the licence in the font.
2. **Turkish.** VCR OSD Mono's 204 glyphs are missing `Ğ Ş İ ğ ş ı`. Departure Mono has 1186 and
   covers them. A Turkish version of this page was always plausible, and with VCR those six letters
   would have fallen back per-glyph to another family — visible, and unfixable in CSS.

Both faces have the lo-fi terminal character the design wants; only one of them can set the whole
page.

---

# Chakra Petch (headings)

- **Designer:** Cadson Demak — the Chakra Petch Project Authors
- **Weights shipped:** 600 SemiBold, 700 Bold
- **Source:** https://github.com/google/fonts `ofl/chakrapetch` — downloaded 2026-08-21
- **Licence:** SIL Open Font License 1.1, text in `ChakraPetch-LICENSE.txt` and embedded in the
  binaries (name ID 13).

Taken from the upstream repository rather than from the Google Fonts CSS endpoint on purpose: that
endpoint serves a **subset**, and the latin-only slice it hands a browser by default drops the six
Turkish letters this project already lost once with VCR OSD Mono. 773 glyphs here, `Ğ Ş İ ğ ş ı`
included, and the OFL text travels with the files.

**Two families, two jobs.** Departure Mono sets the wordmark, the labels and the body — it is a
pixel face and it stays on its 11px grid. Chakra Petch sets the headings only: it is genuinely
angular, its corners are cut rather than rounded, and at display size it carries the technical
register the pixel face starts to read as "game" in.
