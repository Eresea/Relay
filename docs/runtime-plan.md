# Runtime module plan

**Status:** in progress; live metric mapping waits for the Leaf Grafana inventory.

## Goal

Give Relay an on-demand view that answers: is Leaf healthy, what changed, and
where should I look next? Leaf is the first project. Its production site is
`https://leaf.eresea.net`; Nexus at `https://nexus.eresea.net` is an upstream
dependency to represent from Leaf's point of view.

Relay presents operational signals and links to their source. Grafana remains
the metrics and alert source of truth. The desktop app does not become a metrics
collector or public status host.

## Domain model

- **Project:** a codebase/repository, initially Leaf.
- **Component:** a deployable unit, initially the Leaf API.
- **Environment:** where a component runs, initially production.
- **Instance:** one running copy of a component. Discover the actual count from
  Grafana/runtime inventory rather than assuming the Compose service count.
- **Dependency:** a component another component relies on. Initially, Leaf's
  observed dependency on Nexus; expose only the signals available to Leaf.
- **Signal:** a timestamped health state, metric, deployment, or incident.

Keep these terms independent of Grafana's dashboard and panel layout. That
allows a future project to describe different operational signals without
changing what a project or component means.

## First user experience

Add an opt-in **Runtime** view to Relay's main window and command palette. It
opens on a compact Leaf production overview. The hidden main window and quiet
startup remain the default; the HUD can surface actionable incidents in a
later phase.

The overview should show:

- Overall state and active alert/incident count.
- One row per component, with an optional column per environment or region.
- A clear state, one useful current number, and the observation time in each
  cell. Example: `Degraded · 2/3 instances · 1.8% errors · updated 12s ago`.
- A Nexus dependency indicator when a reliable signal exists.
- A deep link to the relevant Grafana dashboard or panel.

The detail view can add a short time range, a few agreed metrics, deployment
markers, and source links. Start with metrics Grafana already collects, such as
request rate, p95 latency, and 5xx rate if those are present. Do not invent
thresholds or treat missing data as healthy.

States are **Operational**, **Degraded**, **Down**, **Unknown/Stale**, and
**Maintenance**. Stale or unreachable Grafana data must be distinguishable from
a healthy service. Use text and timestamps alongside color.

## Module seam

Keep the view in `src/app/features/runtime/`. Keep Grafana HTTP access,
authentication, timeouts, response parsing, and error redaction in the Rust
core, behind the existing Tauri bridge. The Angular view consumes a small,
typed, normalized runtime snapshot and does not build Grafana queries or handle
credentials.

Use the existing HTTP and OS credential-store dependencies. Store non-secret
connection settings in Relay settings and any token in the OS credential
store. Keep Grafana access read-only. Do not add a provider framework for the
first Grafana integration; introduce a shared adapter interface when a second
real data source needs to fit the same seam.

The initial setup screen stores Grafana and dashboard URLs under
`runtime.grafana` in Relay's existing settings store. The API token is optional
and stored in the OS credential store. All fields start blank; no Grafana
queries run until the datasource and panels are identified.

Polling happens only while Runtime is open in the first release. Keep the last
successful observation and its timestamp so a failed refresh can show stale
data without displaying a false green state. Relay being closed does not count
as uptime monitoring.

## Delivery plan

1. **Inventory Grafana.** Confirm its URL and edition/version, the datasource
   type, the Leaf dashboard/panels, existing alert rules, the metrics available
   for Nexus, and whether Relay can reach Grafana directly. Select the narrowest
   read-only authentication option. Do not send credentials in chat.
2. **Prove one read-only query.** Choose the integration route from the
   inventory: a Grafana dashboard/query API, a directly reachable datasource,
   or dashboard links plus a smaller native status source. Verify returned
   values, units, freshness, and failure behavior before designing the grid
   around them. If Grafana has only host/container metrics, add the smallest
   Leaf-side health and request telemetry needed by the existing metrics stack
   before building the native overview. Relay must not query Leaf's database
   directly.
3. **Ship Leaf's overview.** Add the Runtime entry and a single-project,
   production-first grid. Show the chosen health state and a few metrics,
   timestamps, stale/unknown states, and Grafana deep links. Keep polling
   bounded to the open view.
4. **Add diagnosis.** Add compact history and deploy annotations after the
   overview answers the fast-status question. Prefer deployment SHA/version
   events already available from GitHub Actions.
5. **Add incident communication.** Display Grafana alerts and maintenance
   state. Consider a public status page only with an always-on hosted publisher;
   Relay's desktop process cannot provide availability while closed.
6. **Extend carefully.** Add another project only when it has a concrete
   signal mapping. Generalize the provider seam when a second provider exists.

## Future use across apps

Reuse the overview and common states where they fit; keep each app's signals
specific to its work:

- **Leaf:** API availability, latency/error rates, database health, and the
  Leaf-to-Nexus dependency.
- **Nexus:** API availability and aggregate auth/sync failures or conflicts;
  never expose credentials, vault contents, or per-user payloads.
- **Bellum:** simulation tick time, queued or stalled work, and persistence
  lag.
- **Relay:** connector/job health, update availability, and release build
  status.
- **LogOS:** build and boot/test results by target, which fit a validation
  matrix better than a live-service metrics chart.

## Pilot acceptance

- Leaf production has a readable current state, selected metric values, units,
  and observation time.
- Nexus appears only when there is a dependable Leaf-facing health signal.
- Missing, stale, failed, and maintenance data cannot appear as healthy.
- A user can reach the existing Grafana view from the relevant row.
- Grafana credentials stay out of the Angular UI, settings JSON, and logs.
- Grafana outages do not prevent Relay from opening or using other features.
- All requests are read-only; no remote restart or deployment action is part of
  the pilot.

## Deferred ideas

- Multi-project and multi-region service matrices.
- Error-budget/SLO burn, certificate expiry, backup freshness, and capacity
  indicators where they answer a real operational question.
- Deploy-versus-error correlation and incident timelines.
- Relay HUD notifications with per-project severity and quieting controls.
- Incident updates, maintenance scheduling, subscriptions, and a hosted public
  status page.
- Remediation actions, only after permission, confirmation, and audit behavior
  are designed.

## Open decisions

The Grafana inventory determines the first query path, metrics, thresholds,
refresh cadence, and whether Nexus can be shown as a dependency. Public status
publishing remains a separate hosting decision.
