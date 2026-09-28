# Umbra repository instructions

- Read `docs/design-system.md` before changing tokens or component styling; it is the source of truth for shared visual decisions.
- Keep this repository usable by multiple consumer projects. Do not add a consumer's app aliases, routes, domain features, global resets or icon registry to shared code.
- Add and migrate one component at a time. Use `.agents/skills/umbra-component/SKILL.md` for its identity, portability and design audit.
- Put shared behavior and styling here when it belongs to Umbra. Keep one-consumer exceptions in that consumer until another consumer needs the same rule.
- Reuse skills supplied by the active consumer project for general design, testing and writing tasks. Keep only Umbra-specific workflow in this repository; do not copy parent-project skills.
- Use repository scripts as the command source. Do not add a second command catalog to these instructions.
