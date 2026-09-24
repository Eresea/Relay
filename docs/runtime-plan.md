# Runtime module plan

**Status:** in progress; Grafana health, dashboard and panel metadata discovery
are implemented, and Leaf API liveness is polled. Metric mapping awaits the
configured Grafana inventory.

## Goal

Give Relay an on-demand view that answers: is Leaf healthy, what changed, and
where should I look next? Leaf is the first project. Its production site is
`https://leaf.eresea.net`; Nexus at `https://nexus.eresea.net` is an upstream
dependency to represent from Leaf's point of view.

Relay presents operational signals and links to their source. Grafana remains
the metrics and alert source of truth. The desktop app does not become a metrics
collector or public status host.

Treat Runtime as an **operational cockpit**, not a general chart builder. Its
first job is to answer “what needs attention?” at a glance; each status must
link to the signal and source that justify it. Keep raw exploration in Grafana
and show only a small, deliberately chosen set of decision-useful indicators
inside Relay.

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
- A standalone Nexus readiness signal with its probe location. Label it as a
  Leaf dependency only when a Leaf-facing signal exists.
- A deep link to the relevant Grafana dashboard or panel.

The detail view can add a short time range, a few agreed metrics, deployment
markers, and source links. Start with metrics Grafana already collects, such as
request rate, p95 latency, and 5xx rate if those are present. Do not invent
thresholds or treat missing data as healthy.

Use a compact hierarchy: **portfolio glance → project/environment grid →
component detail → source**. The grid is the fast path; charts and timelines
are supporting evidence, not the landing view. Every number carries a unit,
time range, and observation time. Every derived state explains the rule or
source behind it. Make stale, partial, and unavailable observations explicit.

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
metric queries run until the datasource and panels are identified. A manual connection
check now reads Grafana's health endpoint and lists up to 50 dashboards
available to the saved credential; a discovered dashboard can be saved as the
default Grafana destination. Relay can also inspect a dashboard's panel IDs,
titles, types, and datasource labels without reading metric values. Panel
inventory tries Grafana's newer dashboard read route first and falls back to
the legacy route when the newer route is unsupported or its default namespace
does not contain the dashboard. Confirm Grafana version, namespace, and folder
coverage before adding metric queries. These checks confirm access to Grafana
only; they are not Leaf health signals. Leaf already exposes an unauthenticated
`GET /api/version/health`; Relay checks this every 30 seconds while the Runtime
view is mounted. It only proves the endpoint returned its healthy response, not
database readiness, request performance, or Leaf-to-Nexus connectivity. Relay
also checks Nexus's public `/readyz` endpoint every 30 seconds; that confirms
Nexus API and PostgreSQL readiness from the Relay client, not from Leaf's
network path. A failed refresh keeps the last successful response visibly stale
instead of green. A successful observation also becomes stale after 90 seconds
without a newer success, so a suspended or stalled poll loop cannot leave an
old green state indefinitely.

Polling happens only while Runtime is open in the first release. Keep the last
successful observation and its timestamp so a failed refresh can show stale
data without displaying a false green state. Relay being closed does not count
as uptime monitoring.

## Delivery plan

1. **Inventory Grafana.** Confirm its URL and edition/version, the datasource
   type and UID, the Leaf dashboard/panels, existing alert rules, the metrics available
   for Nexus, and whether Relay can reach Grafana directly. Select the narrowest
   read-only authentication option. Do not send credentials in chat.
2. **Prove one read-only query.** Choose the integration route from the
   inventory: a Grafana dashboard/query API, a directly reachable datasource,
   or dashboard links plus a smaller native status source. Verify returned
   values, units, freshness, and failure behavior before designing the grid
   around them. If Grafana has only host/container metrics, add the smallest
   Leaf-side request telemetry needed by the existing metrics stack. The
   inspected Leaf API and deployment trees contain no application-level HTTP
   request metrics setup; that does not rule out external host/container
   collectors. The existing HTTP endpoint supplies liveness only. Relay must
   not query Leaf's database directly.
3. **Ship Leaf's overview.** Add the Runtime entry and a single-project,
   production-first grid. Show the chosen health state and a few metrics,
   timestamps, stale/unknown states, and Grafana deep links. Keep polling
   bounded to the open view.
4. **Add diagnosis.** Add compact incident/signal history, deployment
   annotations, and a “what changed?” path after the overview answers the
   fast-status question. Prefer deployment SHA/version events already available
   from GitHub Actions. Where possible, correlate deploys with error and
   latency changes without implying causation.

   Do not treat Leaf's `/api/version` response as a release marker until its
   production configuration is verified: the controller defaults `version` to
   `1.0.0` and synthesizes a fresh `buildTimestamp` on every request when that
   setting is absent. Prefer an immutable CI commit or image digest.

5. **Add incident operations.** Display alert state, acknowledgement/owner,
   maintenance windows, and links to the existing runbook or source. Keep
   alert lifecycle and maintenance ownership with the existing monitoring
   system until a real need for Relay-side editing exists.
6. **Evaluate status publishing separately.** A Statuspage-like experience
   needs an always-on independent checker/publisher, incident history,
   maintenance communication, and an externally reachable public endpoint.
   Relay may become its operator console, but its desktop process cannot
   provide availability while closed. Start with private status review; only
   build public publishing after choosing its host, uptime probe, audience,
   security model, and update workflow.
7. **Extend carefully.** Add another project only when it has a concrete
   signal mapping. Generalize the provider seam when a second real source needs
   the same interface.

## Useful follow-on ideas

Order these by whether they improve a real decision, not by chart count:

1. **Freshness and confidence.** Show last observation, source, partial-data
   state, and stale age. This is foundational; otherwise an old green result
   looks live.
2. **Change context.** Put deploy/version markers and incident changes beside
   the relevant time series. Link to commits or CI runs; don't infer that a
   nearby deploy caused an incident.
3. **Dependency path.** Show Leaf → Nexus with the exact Leaf-facing signal
   and explain when no reliable dependency signal exists. Grow this into a
   small dependency map only when it helps localize failures.
4. **Operational objectives.** Add SLO/error-budget burn, capacity, backup
   freshness, and certificate expiry only when their source, threshold, owner,
   and action are defined. Prefer “what is at risk and by when?” over more
   decorative gauges.
5. **Incident readiness.** Surface alert/runbook links, maintenance windows,
   affected components, and a concise timeline. Later, support status updates
   and subscriptions through an always-on hosted system.
6. **Useful handoffs.** Open the right Grafana panel, CI run, deploy, runbook,
   or project issue from a degraded cell. Consider remediation buttons only
   after their permission, confirmation, and audit path are designed.
7. **Quiet attention.** Much later, let Relay's HUD notify on actionable
   state transitions with per-project severity, quiet hours, and deduplication.
   Do not turn periodic metric movement into notifications.

## Reuse across products

Share the small presentation vocabulary—state, freshness, time range, source,
and drill-down behavior—where it genuinely fits. Do not force every product
into a server-health dashboard:

- **Leaf:** production API and dependency health; latency/error trends; deploy
  context; eventually SLO and incident views.
- **Nexus:** API, auth, and sync operational signals aggregated safely. Keep
  account-level data, credentials, and vault payloads out of operational
  summaries.
- **Bellum:** simulation progress, tick duration, queued/stalled work, and
  persistence lag. A recent successful simulation is more useful than generic
  CPU charts.
- **Relay:** connector sync freshness/failures, background job state, update
  availability, and release build status. Distinguish local connector errors
  from remote provider incidents.
- **LogOS:** build/boot/validation outcomes by target and revision. Use a
  validation matrix and run history rather than uptime-style status cells.

The shared concept is **operational signal**, not a universal metric schema.
Keep product-specific meaning and thresholds close to each product's owner.

## Pilot acceptance

- Leaf production has a readable current state, selected metric values, units,
  and observation time.
- Nexus readiness is labeled as a direct Relay-client probe; it is not presented
  as proof of Leaf-to-Nexus connectivity.
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
  status page with an independent uptime checker.
- Remediation actions, only after permission, confirmation, and audit behavior
  are designed.

## Open decisions

The Grafana inventory determines the first query path, metrics, thresholds,
refresh cadence, and whether Nexus can be shown as a dependency. Public status
publishing remains a separate hosting decision.
