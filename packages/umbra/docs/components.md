# Umbra components

Umbra components have their own stable identities and public contracts. Legacy component names are temporary compatibility details owned by each consuming project; they are not part of this library's public naming.

Migrate one component at a time. For each migration:

1. Add the `umbra-*` implementation under `src/components/`.
2. Audit its public inputs, outputs, native semantics, accessibility, interaction states, token use and dependencies against `docs/design-system.md`.
3. Validate it in the reference consumer and update the consuming project's callers.
4. Remove its old implementation after callers are migrated; keep only a small compatibility adapter if a consumer still requires it.

The source directory is the component inventory. Record only decisions and contracts here that cannot be derived from the source.

## Button

`umbra-button` renders a native button. Its variants are `default`, `secondary`, `outline`, `ghost`, `destructive` and `link`; sizes are `sm`, `md`, `lg` and `icon`. Icon content uses `[umbraButtonIcon]`. Icon-size buttons require `ariaLabel` or `ariaLabelledBy`. An optional `action` can return a promise or observable; while it is pending the button disables itself, sets `aria-busy`, and reports failures through `actionError`.

## Badge

`umbra-badge` renders inline text with `default`, `secondary`, `outline` or `destructive` styling. Destructive badges use the semantic danger colour and must include text that names the state.

## Separator

`umbra-separator` draws a horizontal line by default and accepts `vertical` orientation. It is decorative by default; set `decorative` to `false` to expose a semantic separator with its orientation to assistive technology.

## Skeleton

`umbra-skeleton` is always hidden from assistive technology. Set `width` and `height` to match the loading content, `shape` to `rectangle` or `circle`, and `radius` to `sm`, `md` or `lg`. `animation` accepts `shimmer`, `pulse` or `none`; motion slows under reduced-motion preferences.

## Empty state

`umbra-empty-state` renders as a polite status, requires a `title`, and optionally accepts a `description`. It exposes an optional decorative icon slot with `[umbraEmptyStateIcon]` and an action slot with `[umbraEmptyStateAction]`.

## Checkbox

`umbra-checkbox` wraps a native checkbox and implements Angular's signal `FormValueControl<boolean>`. It supports an optional label, hint, error, native form attributes, and a `touch` output on blur. Use `ariaLabel` or `ariaLabelledBy` when no visible label or enclosing native label names it. Set `threeState` to cycle through unchecked, checked, and indeterminate values.

## Switch

`umbra-switch` wraps a native checkbox with switch semantics and implements Angular's signal `FormValueControl<boolean>`. It supports an optional label, hint, error, native form attributes, and a `touch` output on blur. Use `ariaLabel` or `ariaLabelledBy` when no visible label or enclosing native label names it.

## Tooltip

`umbraTooltip` opens a token-styled, connected tooltip on hover or keyboard focus, positions it with CDK Overlay, and adds its id to the trigger's `aria-describedby`. Set `tooltipPosition` to `top`, `right`, `bottom` or `left`; provide either tooltip text or sanitized `tooltipHtml`. Consumers need `@angular/cdk`, `@angular/platform-browser`, and the CDK overlay styles.

## Menu

`umbra-menu` renders a named action menu with native menuitem buttons. Supply a required `ariaLabel` and items with unique ids and labels; items may also include a shortcut, disabled state, or destructive state. Arrow keys move between enabled items, Home and End move to the first and last, Escape emits `dismiss`, and selecting an item emits `selected` followed by `dismiss`. Place the menu inside a consumer-owned overlay.

## Radio group

`umbra-radio-group` wraps native radio inputs in a fieldset and implements Angular's signal `FormValueControl<UmbraRadioValue | null>`. Supply options with unique string or number values; each option can include hint text or be disabled. The group supports a legend, horizontal or vertical layout, validation feedback, a native group name, and a `touch` output on blur.

## Input

`umbra-input` wraps a native input and implements Angular's signal `FormValueControl<string>`. It supports text, email, password, search, telephone, URL, number, date/time, color, month and week types; native validation and form attributes; an optional label, hint or error; character count; prefix and suffix slots (`[umbraInputPrefix]`, `[umbraInputSuffix]`); and optional clear and password-visibility actions. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur and `enter` emits when Enter is pressed.

## Textarea

`umbra-textarea` wraps a native textarea and implements Angular's signal `FormValueControl<string>`. It supports native rows, resize behavior and form attributes, an optional label, hint or error, character count, and content-based auto-resizing. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur; native keyboard events bubble from the textarea.

## Slider

`umbra-slider` wraps a native range input and implements Angular's signal `FormValueControl<number>`. It supports numeric `min`, `max` and `step`, an optional label, hint or error, native form attributes, and an optional value output. Use `ariaLabel`, `ariaLabelledBy`, or a native enclosing label when there is no visible component label. `touch` emits on blur.

## File input

`umbra-file-input` keeps the native file input focusable and labels it with the projected content. Set `accept` and `multiple` as needed; `fileSelected` emits the native change event so the consumer can read the selected files.

## Select

`umbra-select` is a searchable, paginated single select backed by a consumer-provided `UmbraSelectDataSource`. It implements Angular signal forms and supports resolving selected values, disabled options, loading and retry states, clear, width strategies and configurable labels. The panel uses CDK Overlay; consumers need `@angular/cdk` and its overlay styles.

## Date

`umbra-date` implements Angular signal forms with individually focusable day, month and year segments. It emits date-only `YYYY-MM-DD` values, advances between complete segments, accepts full-date paste, and offers day, month and year calendar views. Consumers need `date-fns`, `@angular/cdk`, and the CDK overlay styles.

## Progress

`umbra-progress` renders a linear or circular determinate or indeterminate progress indicator. Set the required `ariaLabel` to name the work, `value` to a number or `null` while indeterminate, and `max` to the determinate range.

## Table

`umbra-table` is a virtualized, sortable and filterable data grid with optional row selection, column pinning, resizing, and cell templates. Supply a required `ariaLabel`, `height`, rows and typed column definitions. Provide a stable `rowId` when rows can reorder or row selection is enabled. The grid supports arrow and page-key cell navigation; Tab remains native. Resizable columns support pointer dragging and arrow-key sizing. Consumers using this component must provide `@tanstack/angular-table` and `@tanstack/angular-virtual`.

## Chart

`umbra-chart` renders and updates a TanStack DOM chart from its definition. Supply the chart definition, accessible label, and pixel height; `ariaDescription`, `className`, and `focusChange` are optional. Consumers using this component must provide `@tanstack/charts`.

## Timeline

`umbra-timeline` renders ordered items in left, center and right projected templates, with optional adjacent grouping, summary values, loading skeletons, and lazy loading. Supply `items` and an accessible `ariaLabel` where the context is not obvious. `trackBy`, `groupBy`, `groupLabel`, `headerData`, and the `left`, `middle`, `right`, and `group` templates customize content; set `hasMore` and `loading`, then handle `loadMore` for pagination.
