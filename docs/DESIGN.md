# Design

Relay is built on **Umbra**, a design system for minimal desktop applications —
neutral zinc palette, hairline borders, small radii, restrained motion, tuned
for native desktop chrome rather than web pages. Dark is the default; light is
a complete mirror of every semantic token.

## How the binding works

`src/styles/tokens/` mirrors Umbra's own file names one for one:

| File             | Holds                                          |
| ---------------- | ---------------------------------------------- |
| `fonts.css`      | Geist and Geist Mono `@font-face` declarations |
| `colors.css`     | zinc ramp, semantic roles, both themes         |
| `entities.css`   | the seven identity hues and the tile recipe    |
| `overlay.css`    | the glass tier                                 |
| `typography.css` | eight sizes, tracking, the utility classes     |
| `spacing.css`    | the 2px scale and the fixed layout constants   |
| `radius.css`     | 3 / 5 / 7 / 10 / 14 and the pill               |
| `elevation.css`  | hairline shadows, the focus ring               |
| `motion.css`     | four durations, two curves, reduced-motion     |
| `base.css`       | reset and the global rules                     |

`src/styles.css` is an import list and nothing else, exactly as Umbra's is.
When Umbra changes, the corresponding file here can be replaced directly.

## Deviations, and why

**Fonts are vendored, not loaded from Google Fonts.** Umbra links the CDN.
Relay is a desktop app: it must render with the network down, and it should not
announce every window open to a third party. The five weights actually used are
committed under `src/assets/fonts/` (Geist, SIL Open Font License).

**Icons are vendored, not loaded from unpkg.** Same reason. The glyphs in use
are committed under `src/assets/icons/` from `lucide-static@0.544.0` (ISC).
`scripts/sync-icons.mjs` refreshes them; it needs network access and is not
part of the build.

**No logo.** Umbra deliberately invents no mark, and neither does Relay. The
wordmark is "Relay" in Geist Semibold at `-0.045em`. The window icon is a
placeholder tile; replace it with `npx tauri icon path/to/mark.png`.

**Exact token values are reconstructed from Umbra's README**, not read from its
`tokens/*.css`, because Umbra is not published as a design system artifact yet.
The semantic structure, the surface values, the accent, the radii, the spacing
scale, the layout constants, the motion curves and the glass recipe are all as
documented; the finer alpha values on borders and shadows were derived. Publish
Umbra and these can be synced exactly.

## The rules that bite

Most of Umbra is conventional. These four are the ones that get broken:

**Hue means _which_. Status means _how it is going_.** The seven entity hues
identify a long-lived object — an agent, a job, a service — and are assigned by
stable hash of its id (`core/entity-hue.ts`), so the same object is the same
colour on every surface. Never colour a tile red to mean failure; that is
`--status-blocked` on the dot and the track. Hue appears only on tiles, dots
and tracks — never on text, container borders, backgrounds or headings. One hue
per object, not per row: five agents show five hues, five files show none.

**App surfaces are flat and opaque. Desktop surfaces are glass. Nothing in
between.** The palette and the HUD float over the user's wallpaper, so they take
the glass tier: 80% translucent fill, `blur(22px) saturate(1.35)`, a rim-light
inset along the top edge, a cool ambient tint, and a shadow far wider and
softer than any in-app card gets. Everything inside the main window is flat.
Never blur a card or a sidebar. `--glass-fill-solid` is the opaque fallback —
every glass surface must stay legible when `backdrop-filter` silently does
nothing.

**The cursor never changes.** Nothing sets `cursor: pointer`. Affordance is
carried by the hover tint and the ink lift, which means _every_ interactive
variant must visibly change on hover, since the arrow will not. Only
`not-allowed` on disabled controls overrides it.

**Text fields own their whole focus indicator.** The global `:focus-visible`
ring in `base.css` explicitly excludes `input`, `textarea` and
`[contenteditable]`. Without that exclusion the bare input draws a tight inner
ring on top of its wrapper's border and focus reads as two rings. A field
focuses by lifting — fill from `--bg-sunken` to `--bg-app`, border to
`--border-focus`, one 3px haze outside it — never by glowing.

## Voice

Quiet, exact, second person. Sentence case everywhere except the 11px uppercase
micro-caption used for section headers. No terminal punctuation on labels; help
text and alert bodies are full sentences and do end in one. One line, then stop.

Buttons name the action, not the assent: _Create_, _Delete_, _Resume_ — never
_OK_ or _Submit_. Numbers are specific: "4,128 files · updated 2m ago", not
"several files, recently", and they are set in Geist Mono at `--text-subtle`.

State what is true and what it costs. A blocked action names its blocker. A
missing value says `Unavailable` rather than showing a zero. Never synthesise a
progress percentage out of conditions that are simply met or not — the HUD's
`progress` input accepts `null` for exactly this reason.

No emoji. No exclamation marks. No apologies.
