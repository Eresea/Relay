# Umbra design system

Umbra is the design system for everything in this repository. One theme, one
visual direction, one set of tokens. If a decision is not written down here, it is
not a decision yet — write it here before shipping it.

Umbra is a system for **minimal desktop applications**: software that keeps one
job on screen at a time and hides everything else behind a keystroke. It is
shadcn-adjacent in temperament — neutral zinc palette, hairline borders, small
radii, restrained motion — but tuned for native-feeling desktop chrome rather than
web marketing pages: 38px title bars, 248px sidebars, 28/32/38px controls,
34px list rows.

**Dark is the default theme.** Light is a complete mirror of every semantic token,
opted into with `class="light"` or `data-theme="light"` on `<html>`.

## Structure

| Path | Purpose |
| --- | --- |
| `src/styles/umbra/umbra.scss` | The complete token and baseline style entry point. |
| `src/styles/umbra/_*.scss` | Colour, typography, spacing, radius, elevation, motion and entity tokens. |
| `src/components/` | Reusable UI components. |
| `docs/components.md` | Component identities and their public contracts. |
| `.agents/skills/umbra-component/` | The Umbra-specific component audit and migration workflow. |

Umbra is the source of truth for shared visual decisions. Consumer-specific layout and behavior stay in the consuming project.
## The rules

### Content

**Voice: quiet, exact, second person.** The interface addresses the user as *you*
and never refers to itself as *I*. It states what is true and what will happen — it
does not enthuse.

**Sentence case everywhere** — buttons, menu items, dialog titles, tabs, field
labels. The single exception is the uppercase micro-caption (11px, `0.06em`
tracking, `--text-subtle`, class `u-caption`) used for section headers in sidebars,
menus and table heads.

**No terminal punctuation on labels.** Buttons, labels, badges and menu rows carry
no full stop. Help text, descriptions and alert bodies are full sentences and do.

**One line, then stop.** A description under a heading gets one sentence. If it
needs two, the feature needs rethinking, not more copy.

**Never emoji.** Not in UI, not in empty states, not in toasts. Status is carried
by a status dot or a glyph.

**Numbers are specific.** "4,128 files · updated 2m ago", not "several files,
recently". Sizes, counts, durations and paths are set in Geist Mono at
`--text-subtle`, with tabular figures so they do not jitter while the clock runs.

**Buttons name the action, not the assent.** `Create`, `Delete`, `Resume`,
`Save changes` — never `OK`, `Submit`, `Yes`.

**Say what it costs.** A blocked action names its blocker (*Blocked — needs 2 more
requirements*). A missing value says `Unavailable` rather than showing a zero that
reads as real data. An unconfigured widget states what is missing and offers the
next action instead of rendering fake data. Never present a state-changing action as a dry run.

**Report state in words as well as colour**: `Met` / `Blocked`, `+4.2%` / `-3`,
`Rising` / `Falling`. Never synthesise a completion percentage out of conditions
that are simply met or not.

Contractions are used. Jargon is allowed where it is the accurate word — the
audience is technical. Apologies are not: no "Oops", no "Sorry", no exclamation
marks anywhere.

### Colour

One cool neutral ramp (zinc 50→1000) does the structural work. Colour enters
through **objects**, not decoration.

The **primary action is monochrome** — near-white on near-black in dark mode,
inverted in light. Not blue. A single blue (`--accent`, `#3b82f6`) is reserved for
focus rings, quiet "in progress" tints and onboarding surfaces. Green, amber and
red appear **only** as status.

**Two background colours per screen, maximum**: `--bg-app` and `--bg-sunken`. The
Data visualizations may use additional semantic colors when the data requires them.

### Entity hues

Seven hues — indigo, violet, cyan, emerald, amber, orange, rose — exist so that
every long-lived object the app supervises is recognisable at a glance across
surfaces: a workspace, a service, a resource or an active process.

The recipe is fixed and never improvised: **13% fill, 30% edge, full-saturation
glyph**, plus a matching progress track. Assign a hue by stable hash of the
object's id (`hueFor()` in the component source) or set it explicitly. The
same object keeps the same hue everywhere.

Three rules keep this from becoming confetti:

1. **Hue means *which*. Status means *how it is going*.** Never colour a tile red
   to mean failure — that is `--status-blocked` on the dot and the track.
2. **Hue only appears on tiles, dots and tracks.** Not on text, not on container
   borders, not on backgrounds, not on section headers.
3. **One hue per object, not per row.** Use stable hues when they help users
   distinguish related entities; keep unrelated values and ordinary file lists
   neutral.

### Surfaces

Surfaces stack **by value, not by shadow**:

| Token | Role |
| --- | --- |
| `--bg-sunken` | Sidebars, rails, input wells |
| `--bg-app` | The canvas |
| `--surface-card` | Grouped content |
| `--surface-raised` | Controls that should feel pressable |
| `--surface-overlay` | Menus, dialogs, the palette |

Never nest a painted surface inside a painted surface. When you want a second
level, the answer is open rows and a separator. A dashboard owns one surface frame
per widget, and the live content inside stays transparent.

Structural wrappers get no border, radius or background of their own.

### Type

Geist for everything, Geist Mono for anything countable. Ten sizes, 11→38px; body
is 14/1.5, UI labels are 13/500. Tracking tightens as size grows (`-0.011em` at
body, `-0.02em` at display). **Display type is used once per screen at most** — an
app is not a landing page.

Use the role tokens (`--type-body`, `--type-ui`, `--type-caption`, `--type-mono`,
`--type-heading`, `--type-title`, `--type-display`) rather than assembling a font
shorthand by hand.

### Spacing

2px base unit; the used steps are 2, 4, 6, 8, 12, 16, 24, 32, 48, 64. Fixed layout
constants: sidebar 248 (collapsed 56), title bar 38, toolbar 44, list row 34,
overlay minimum width 192, content column max 760px centred. **Content panes are
centred with a max width even on a 2560px monitor** — never let a line of prose
run the width of the display.
### Radii

3 / 5 / 7 / 10 / 14, plus a pill for switches, tracks and dots. Small controls get
5–7; cards and dialogs get 10–14. **Nothing is fully rounded except tracks, dots
and avatars** — including icon buttons and close buttons, which are square.

### Borders and shadows

Borders do the work shadows usually do. Every card, control and overlay has a 1px
border: `--border-subtle` (6% white) for internal rules, `--border-default` for
container edges, `--border-strong` for overlays and hovered interactive cards.

Shadows are hairline and almost invisible: cards are flat, controls get
`--shadow-xs`, tooltips and menus `--shadow-md`, dialogs `--shadow-lg`. **There are
no glows, no coloured shadows, and no inner shadows** beyond a 4%-white top
hairline on keycaps. A shadow never means important.

### Backgrounds

Flat. No gradients, no photography, no illustration, no noise, no repeating
pattern. The only gradients in the system are the shimmer sweep inside a skeleton
and the ambient tint mixed into the glass tier. **If a surface needs to recede, it
changes value — it does not gain texture.**

### The glass tier

Transparency and blur are for interaction tints (white at 4/6/7% over any surface,
so hover works on every background without a bespoke colour), overlay scrims
(`--scrim` plus `--blur-overlay` behind dialogs and the palette), and the glass
tier.

The glass tier is for surfaces that float over the **app canvas**, such as a tray popover, notification, context menu or command palette. Recipe: 80% translucent fill, `blur(22px) saturate(1.35)`, a 1px
`--glass-edge` hairline, a rim-light inset along the top edge only, and a shadow
far wider and softer than any in-app card gets. Use `UmbraGlassPanelComponent` or
the `.u-glass` utility — both keep `--glass-fill-solid` as the base so the surface
stays legible where `backdrop-filter` silently does nothing.

This is **the only place** in Umbra where depth comes from light rather than from
value, and it is the boundary of the rule: if a surface belongs to the app window
it is flat and opaque; if it floats over something else it is glass. Nothing in
between. **Never blur a card or a sidebar.**

### Motion

80ms press, 120ms hover, 160ms panel, 240ms overlay, on `cubic-bezier(.2,0,0,1)`
(overlays use `cubic-bezier(.16,1,.3,1)`). Overlays fade and scale from 97%; toasts
slide up 8px. Nothing bounces, nothing springs, nothing exceeds 240ms. Motion
communicates state and never changes layout.

Interaction durations collapse to 0 under `prefers-reduced-motion`. **Indeterminate
indicators and skeleton motion slow rather than freeze**: `--dur-indeterminate`
becomes 2400ms and `--dur-skeleton` becomes 3200ms. A stopped live indicator
reads as a hang.

### States

**The cursor never changes.** Nothing sets `cursor: pointer`; affordance is carried by the hover tint and the ink lift. Only `not-allowed` on disabled controls overrides the default arrow.

- **Hover** — a 4% white tint plus ink lifting from `--text-muted` to
  `--text-body`. Solid buttons go *lighter* and gain a 3px translucent halo in
  their own colour; bordered controls step from `--border-default` to
  `--border-strong`; link buttons pick up a tint and an underline. Every variant
  must change on hover, since the cursor never does.
- **Press** — `translateY(0.5px)`. No scale, no colour change.
- **Selected** — a persistent 6% tint plus medium weight. Never an accent fill.
- **Focus** — one ring, on the element that owns the state: `--focus-ring`, a 1px
  edge plus a 3px low-alpha haze, via `:focus-visible`. Focus must always be
  obvious.
- **Fields focus by lifting, not by glowing.** An input rests as a sunken well with
  a hairline `--border-default`; hover brightens it to `--border-strong`; focus
  raises the fill from `--bg-sunken` to `--bg-app`, takes the border to
  `--border-focus` and adds a single 3px haze outside it. One surrounding border
  that changes with state — never a recoloured border *plus* an inner ring, and
  never the native `<input>` outline. The caret takes `--primary`. Invalid keeps a
  red border in every state. Selected text in inputs and textareas uses a visible
  accent tint from `--input-selection-background` while keeping `--text-body` for
  legibility.
- **Disabled, invalid, destructive, pressed, loading, hover and active must each be
  visually distinct**, and a state change never shifts a control's dimensions or
  alignment.

**Choice controls are labels until touched.** A select has no border or fill at
rest — it reads as a line of muted text with a small chevron. Hover fills a pill
behind it; clicking opens a 10px-radius popover whose rows follow the same rule.
Raised, bordered selects are not used.

Date fields use separate day, month and year segments and return date-only
`YYYY-MM-DD` values. Each segment is individually focusable; typing a complete
segment advances to the next, and pasting a full date fills all three. The field
and calendar share a compact maximum width. Segments are unbordered at rest,
separated by slashes, and fill on hover or keyboard focus without an outline. The
calendar opens below the field.
Clicking the month opens a month grid; clicking the year opens a year grid, and
choosing a year advances to months before dates. Dates and navigation use
semantic controls, and the selected day is exposed in its accessible name.

**Cards** are flat rectangles: 1px `--border-default`, 10px radius, 16px padding,
optional tinted footer bar for actions. No coloured left borders, no accent
headers, no cards inside cards.

### Timelines

Timelines use an open list with a thin neutral axis and small outlined nodes. Group labels sit across the axis in caption type; narrow layouts move the axis to the leading edge and keep item content in one column. Do not add a painted surface around each item.

### Density

Sparse by mandate. A screen shows one job; secondary information lives in the
sidebar footer, the mono status strip, or behind ⌘K. Empty states are designed, not
apologised for, and always offer the next action.

Favour open layouts, rails, lists and clear hierarchy over nested, card-heavy layouts. Spacing responds to viewport size rather than preserving oversized padding.

### Accessibility

Use native semantic elements and behaviour before recreating them in ARIA. Shared form controls preserve browser validation, autocomplete, keyboard, selection, disabled and read-only behaviour. **Every menu item, list row and tab is a real `<button>` with visible focus** — never `role` and a click handler on a div, which Tab skips.

Labels, hints, errors and counts get stable ids wired through `aria-describedby`,
and **error copy replaces hint copy** rather than stacking. Icon-only controls
require an accessible name. Active navigation is `aria-current="page"`, not a
pointer style. Async actions expose `aria-busy` and block repeat activation.

Skeletons are presentation-only and always `aria-hidden`. Work progress uses a
named `progressbar`; omit its value attributes while indeterminate. A static
proportional bar, such as a percentage breakdown, is `role="img"` with a label
naming every share, and the exact values live in a definition list beside it.

The data grid uses `role="grid"` because it implements cell navigation. Arrow and
page keys move between cells, while Tab stays with the browser so users can leave
the grid normally. Column resizing works by pointer and keyboard.

Dialogs dismiss on Escape and return focus to their trigger. Modal keystrokes stay within the active dialog.

Text meets 4.5:1 (3:1 at 24px and above). `--border-subtle` is a hairline, not a
signal: never let a border carry state on its own.

### Iconography

Icons are monochrome and support the meaning of their surrounding label. Icon-only
controls have accessible names. Consumers provide icons through the component's
public content or icon contract; Umbra components do not import a host application's
icon registry.

Never use emoji or text pictographs as icons. Inline SVG remains appropriate for
charts, maps, flags and illustrations — things that are drawings, not glyphs.
## Building on this

- Reuse tokens. Do not hard-code component dimensions, colours, radii, shadows, durations or fonts in a stylesheet, template or style binding.
- Prefer native platform behavior and existing Umbra components over app-specific reimplementations.
- Keep variants and public interfaces opinionated. Add only what a real consumer demonstrates a need for.
- Never let a state change shift a control's dimensions or alignment.
- Consumer-specific behavior belongs in the consuming project. Promote it into Umbra when more than one consumer needs the same behavior.
