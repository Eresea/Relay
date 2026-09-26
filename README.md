# Umbra

Umbra is the shared design system and UI library. This repository owns its visual rules, tokens and reusable components. Consumer projects may vendor it with Git subtree while contributing and updating shared work.

The token and style layer is framework-neutral. Component source currently targets Angular; consumers using another framework can share the styles but need framework-specific component adapters.

## Subtree workflow

Add the repository once in a consumer project, then add Umbra under `packages/umbra`:

```sh
git remote add umbra <umbra-repository-url>
git subtree add --prefix=packages/umbra umbra main --squash
```

Pull shared updates when ready:

```sh
git subtree pull --prefix=packages/umbra umbra main --squash
```

Push changes made inside the subtree back to Umbra:

```sh
git subtree push --prefix=packages/umbra umbra main
```

Keep a component's Umbra changes in a focused commit so they can be reviewed and sent upstream independently from consumer-specific changes. Each consumer chooses when to pull.

## Angular consumers

Umbra components are shared source, not a published npm package. After adding the subtree, map `@umbra/*` to its `src/` directory in the consumer's TypeScript config; adjust the relative path for that app:

```json
{
  "compilerOptions": {
    "paths": {
      "@umbra/*": ["../../packages/umbra/src/*"]
    }
  }
}
```

Keep Angular and RxJS dependencies owned by the consuming app. If its source and the subtree sit outside each other's normal module-resolution paths, map those existing dependencies to the app's `node_modules`. Test runners with an independent resolver need the matching `@umbra` alias and one resolution of framework dependencies from the consuming app (for Vite, use `resolve.dedupe`). Subtree pulls update source without reinstalling dependencies.

Angular CLI's development server also uses Vite, but does not load a consumer's custom Vite config. If importing subtree source creates a second Angular runtime and causes injector errors, exclude the affected Angular packages through `serve.options.prebundle.exclude`; exclude only the packages that need one shared runtime. See [Angular's prebundling guidance](https://angular.dev/tools/cli/build-system-migration).

Components with optional ecosystem dependencies document them in `docs/components.md`; add the consumer-owned packages and resolver entries only when using those components. For example, `umbra-table` requires `@tanstack/angular-table` and `@tanstack/angular-virtual`.

When an Angular path alias maps `@angular/*` directly into `node_modules`, exported subpaths may need an exact alias so TypeScript can use Angular's package exports. For signal forms, map `@angular/forms/signals` to `./node_modules/@angular/forms/types/signals.d.ts` in the consumer's `tsconfig.json`.

## Source layout

- `src/styles/umbra/` contains shared design tokens and baseline styles.
- `src/components/` contains reusable UI components as they are migrated and audited.
- `docs/` contains the canonical design system and component contracts.
- `.agents/skills/umbra-component/` contains the component-specific audit workflow.
