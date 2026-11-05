# Umbra components

Umbra components have their own stable identities and public contracts. Every component ships its own stylesheet; none needs a utility-class framework in the consumer. Legacy component names are temporary compatibility details owned by each consuming project; they are not part of this library's public naming.

Migrate one component at a time. For each migration:

1. Add the `umbra-*` implementation under `src/components/`.
2. Audit its public inputs, outputs, native semantics, accessibility, interaction states, token use and dependencies against `docs/design-system.md`.
3. Validate it in the reference consumer and update the consuming project's callers.
4. Remove its old implementation after callers are migrated; keep only a small compatibility adapter if a consumer still requires it.

The source directory is the component inventory. Record only decisions and contracts here that cannot be derived from the source.

## Button

`umbra-button` renders a native button. Its variants are `default`, `secondary`, `outline`, `ghost`, `destructive` and `link`; sizes are `sm`, `md`, `lg` and `icon`. Icon content uses `[umbraButtonIcon]`. Icon-size buttons require `ariaLabel` or `ariaLabelledBy`. An optional `action` can return a promise or observable; while it is pending the button disables itself, sets `aria-busy`, and reports failures through `actionError`.

## Badge

`umbra-badge` renders inline text with `default`, `secondary`, `outline`, `destructive`, `success` or `warning` styling. Destructive badges use the semantic danger colour and must include text that names the state.

## Card

`umbra-card` provides the shared card surface with an optional title and description, a `[cardActions]` header slot, optional default content, and an optional `[cardFooter]` slot. The header actions stack below the title on narrow screens, and an empty content slot adds no space. Set `headingLevel` to 2, 3 or 4 to match the surrounding page hierarchy; it defaults to 3. Set `interactive` only when the card itself is a target; it then lifts its border on hover.

## Entity tile

`umbra-entity-tile` renders a stable-hue tile for an object. Set `entityId` to derive its hue, `hue` to override it, and `label` only when the tile is the sole carrier of meaning. Project a platform-specific icon with `[umbraEntityTileIcon]`.

## Entity row

`umbra-entity-row` presents an object with its stable-hue tile, name, optional detail, lifecycle state, progress or trailing metadata. Project a platform-specific icon with `[umbraEntityRowIcon]`. Set `interactive` to render a native button; `selected` supplies its pressed state and `activate` emits on activation.

## Glass panel

`umbra-glass-panel` renders the floating glass surface defined by the glass tier. Use it for surfaces over the OS or map, not in-app cards or sidebars. Set `raised` for a nested section inside another glass surface; consumer classes control its layout.

## Metric tile

`umbra-metric-tile` renders a required value and label as a definition list, with optional `tone`, object `hue`, and signed `delta`. Deltas are neutral by default; use `positive` or `negative` only when metric polarity has meaning, never based on the sign alone. Project a decorative host icon with `[umbraMetricTileIcon]`; the value and label carry the metric's meaning. A `hue` is drawn as a dot beside the value, never as coloured text.

## Tabs

`umbra-tabs` requires an accessible `ariaLabel`, tabs with unique values, and the selected `value`. It emits `tabChange`; arrow keys move between enabled tabs, while Home and End reach the first and last enabled tabs. Variants are `underline`, `segmented`, and `group`. To show a font icon, set a tab's `icon` to its text and `iconClass` to the consumer's icon font class.

## Separator

`umbra-separator` draws a horizontal line by default and accepts `vertical` orientation. It is decorative by default; set `decorative` to `false` to expose a semantic separator with its orientation to assistive technology.

## Skeleton

`umbra-skeleton` is always hidden from assistive technology. Set `width` and `height` to match the loading content, `shape` to `rectangle` or `circle`, and `radius` to `sm`, `md` or `lg`. `animation` accepts `shimmer`, `pulse` or `none`; motion slows under reduced-motion preferences.

## Empty state

`umbra-empty-state` renders as a polite status, requires a `title`, and optionally accepts a `description`. It exposes an optional decorative icon slot with `[umbraEmptyStateIcon]` and an action slot with `[umbraEmptyStateAction]`. Set `headingLevel` to 2, 3 or 4 to match the surrounding page; it defaults to 3.

## Kbd

`umbra-kbd` renders a shortcut as separate semantic `<kbd>` elements. Set `keys` to a `+`-separated string or an array of key labels, using the platform's conventional modifier glyphs.

## Status dot

`umbra-status-dot` shows one of the `running`, `waiting`, `blocked`, `done` or `idle` states. It renders the state word when `label` is true and otherwise exposes it as the accessible name. Set `labelText` to override the default word. Only `running` animates; the pulse uses the indeterminate-motion token and slows for reduced motion. Only `running` pulses. `idle` is drawn hollow, because it shares its colour with `done`.

## Checkbox

`umbra-checkbox` wraps a native checkbox and implements Angular's signal `FormValueControl<boolean>`. It supports an optional label, hint, error, native form attributes, and a `touch` output on blur. Use `ariaLabel` or `ariaLabelledBy` when no visible label or enclosing native label names it. Set `threeState` to cycle through unchecked, checked, and indeterminate values.

## Switch

`umbra-switch` wraps a native checkbox with switch semantics and implements Angular's signal `FormValueControl<boolean>`. It supports an optional label, hint, error, native form attributes, and a `touch` output on blur. Use `ariaLabel` or `ariaLabelledBy` when no visible label or enclosing native label names it.

## Tooltip

`umbra-tooltip` provides the `umbraTooltip` directive, which opens a token-styled, connected tooltip on hover or keyboard focus, positions it with CDK Overlay, and adds its id to the trigger's `aria-describedby`. Set `tooltipPosition` to `top`, `right`, `bottom` or `left`; provide either tooltip text or sanitized `tooltipHtml`. Consumers need `@angular/cdk`, `@angular/platform-browser`, and the CDK overlay styles. Hover waits for `--dur-tooltip-delay`; keyboard focus opens it immediately, and Escape dismisses it.

## Menu

`umbra-menu` renders a named action menu with native menuitem buttons. Supply a required `ariaLabel` and items with unique ids and labels; items may also include a shortcut, disabled state, or destructive state. Arrow keys move between enabled items, Home and End move to the first and last, Escape emits `dismiss`, and selecting an item emits `selected` followed by `dismiss`. Place the menu inside a consumer-owned overlay. Typing a letter moves to the next matching item, and the tab stop follows focus. Call `focus()` once the consumer's overlay has opened.

## Popover

`umbra-popover` positions projected content from a labeled trigger and closes on outside click or Escape. Call `close(true)` after a menu action when focus must return to the trigger.

## Dialog

`umbra-dialog` renders projected trigger and content in a modal CDK overlay. It traps focus, closes on Escape or backdrop click by default, and restores focus to its trigger or the element that opened it programmatically. Set `ariaLabel`, `open`, and optionally `size`, `closeOnEscape`, or `closeOnBackdropClick`. Consumers need `@angular/cdk` and its overlay styles. Set `heading` for a visible title, which also names the panel and adds a close button named by `closeLabel`; without it, `ariaLabel` is required, and leaving out both throws. `[umbraDialogFooter]` holds right-aligned actions.

## Drawer

`umbra-drawer` renders a modal side panel with focus management and Escape/outside-click closing. When opened programmatically, it restores focus to the element that was active before opening. Set `side`, `size`, and optionally `mobilePresentation="bottom-sheet"` for a bottom sheet on narrow screens. Consumers need `@angular/cdk` and its overlay styles. Set `heading` for a visible title, which also names the panel and adds a close button named by `closeLabel`; without it, `ariaLabel` is required, and leaving out both throws. `[umbraDrawerFooter]` holds right-aligned actions below the scrolling body.

## Navigation rail

`umbra-nav-rail` provides a labeled navigation container with vertical or horizontal orientation; its default mobile orientation is horizontal. `umbra-nav-item` renders a button with active, disabled, current-page, and popup semantics; consumers own route handling.

## Toast

`umbra-toast` presents a status message with info, success, warning, or danger tone and an optional dismiss action. It exposes polite live status for non-danger messages and an alert for danger messages; consumers own placement, timing, and dismissal state. `dismissLabel` names the icon-only dismiss action.

## Alert

`umbra-alert` presents a persistent inline message with info, success, warning, or danger tone. Set an optional `title`, project decorative icon content with `[umbraAlertIcon]`, and project an optional action with `[umbraAlertAction]`. The host exposes `role="alert"`. `danger` and `warning` announce as `alert`; `info` and `success` announce politely as `status`.

## Radio group

`umbra-radio-group` wraps native radio inputs in a fieldset and implements Angular's signal `FormValueControl<UmbraRadioValue | null>`. Supply options with unique string or number values; each option can include hint text or be disabled. The group supports a legend, horizontal or vertical layout, validation feedback, a native group name, and a `touch` output on blur.

## Input

`umbra-input` wraps a native input and implements Angular's signal `FormValueControl<string>`. It supports text, email, password, search, telephone, URL, number, date/time, color, month and week types; native validation and form attributes; an optional label, hint or error; character count; prefix and suffix slots (`[umbraInputPrefix]`, `[umbraInputSuffix]`); and optional clear and password-visibility actions. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur and `enter` emits when Enter is pressed. `clearLabel`, `passwordLabel` and `hidePasswordLabel` name the icon-only actions. A read-only field drops its well.

## Textarea

`umbra-textarea` wraps a native textarea and implements Angular's signal `FormValueControl<string>`. It supports native rows, resize behavior and form attributes, an optional label, hint or error, character count, and content-based auto-resizing. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur; native keyboard events bubble from the textarea.

## Slider

`umbra-slider` wraps a native range input and implements Angular's signal `FormValueControl<number>`. It supports numeric `min`, `max` and `step`, an optional label, hint or error, native form attributes, and an optional value output. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur.

## File input

`umbra-file-input` keeps the native file input focusable and labels it with the projected content. Set `accept` and `multiple` as needed; `disabled` prevents opening the native picker and keeps its disabled state visible. `fileSelected` emits the native change event so the consumer can read the selected files.

## Select

`umbra-select` is a searchable, paginated single select backed by a consumer-provided `UmbraSelectDataSource`. It implements Angular signal forms and supports resolving selected values, optional secondary option text through `descriptionWith`, disabled options, loading and retry states, clear, width strategies and configurable labels. The panel uses CDK Overlay; consumers need `@angular/cdk` and its overlay styles. Its `label`, `hint` and `error` follow the same field anatomy as `umbra-input`, with the label above the trigger. `descriptionWith` adds a second line to options.

## Date

`umbra-date` implements Angular signal forms with individually focusable day, month and year segments. It emits date-only `YYYY-MM-DD` values, advances between complete segments, accepts full-date paste, and offers day, month and year calendar views. Consumers need `date-fns`, `@angular/cdk`, and the CDK overlay styles. The calendar grid is one tab stop: arrow keys move by day and week, Home and End reach the week's edges, and Page keys change month (with Shift, year). Month and weekday names follow `LOCALE_ID`; every other word comes from `labels`.

## Progress

`umbra-progress` renders a linear or circular determinate or indeterminate progress indicator. Set the required `ariaLabel` to name the work, `value` to a number or `null` while indeterminate, and `max` to the determinate range.

## Table

`umbra-table` is a virtualized, sortable and filterable data grid with optional row selection, column pinning, resizing, and cell templates. Supply a required `ariaLabel`, `height`, rows and typed column definitions. Provide a stable `rowId` when rows can reorder or row selection is enabled. Set `mobileColumnIds` to keep only those columns visible below 768px while preserving the consumer's visibility settings. The grid supports arrow and page-key cell navigation; Tab remains native. Resizable columns support pointer dragging and arrow-key sizing. Consumers using this component must provide `@tanstack/angular-table` and `@tanstack/angular-virtual`. `emptyMessage`, `selectAllLabel` and `selectRowLabel` supply its words.

## Chart

`umbra-chart` renders and updates a TanStack DOM chart from its definition. Supply the chart definition, accessible label, and pixel height; `ariaDescription`, `className`, and `focusChange` are optional. Consumers using this component must provide `@tanstack/charts`.

## Timeline

`umbra-timeline` renders ordered items in left, center and right projected templates, with optional adjacent grouping, summary values, loading skeletons, and lazy loading. Supply `items` and an accessible `ariaLabel` where the context is not obvious. `trackBy`, `groupBy`, `groupLabel`, `headerData`, and the `left`, `middle`, `right`, and `group` templates customize content; set `hasMore` and `loading`, then handle `loadMore` for pagination.
