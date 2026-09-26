---
name: umbra-component
description: Use when adding, migrating, reviewing or materially changing one reusable UI component in the Umbra library.
---

# Umbra component workflow

Work on one component per change. Read `docs/design-system.md` and inspect existing components before editing.

1. Define the component's Umbra identity and smallest useful public contract. Keep consumer-specific selectors, routes and adapters in the consumer.
2. Reuse existing tokens and native platform behavior. Keep implementation dependencies limited to framework-level packages that consumers can satisfy.
3. Check the component's default, hover, focus, pressed, selected, disabled, invalid, loading and reduced-motion states where applicable. Keep accessible names, keyboard behavior and state text explicit.
4. Review every style against the design-system rules: use tokens for dimensions, colour, radius, elevation, duration and typography; test both themes and narrow layouts in a consumer.
5. Keep compatibility in the consumer during migration. Do not add old product names or compatibility selectors to Umbra's permanent public surface.
6. Update `docs/components.md` only when a public contract or reusable decision needs explanation. Keep the source as the inventory.

Use general skills provided by the active consumer project when their task-specific triggers apply; this skill owns only Umbra's component migration and compliance checks.