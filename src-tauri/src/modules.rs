//! The module registry: every capability Relay has, as a module with a
//! manifest — what it gives, what it needs — and whether it is on.
//!
//! The core owns this, not the interface, because the core is where a module
//! does anything: every IPC command a module owns passes [`check_invoke`]
//! before it runs, so an off module cannot be driven from any window, and a
//! command whose permission its module never declared is refused. Turning a
//! module off also stops its background work (see [`set_enabled`]).

use std::collections::HashSet;
use std::fmt;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::events::{AppEvent, EventSink};

/// What a module may touch. Declared up front in its manifest, never
/// requested at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Shell,
    Files,
    Network,
    Mail,
    Vault,
}

impl fmt::Display for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Shell => "run programs",
            Self::Files => "read and write files",
            Self::Network => "reach the network",
            Self::Mail => "read and send mail",
            Self::Vault => "read the vault",
        })
    }
}

#[derive(Debug, Serialize)]
pub struct Need {
    pub permission: Permission,
    /// Where the permission applies: "workspaces", "api.github.com".
    pub scope: &'static str,
}

/// A tab the module opens in the Deck.
#[derive(Debug, Serialize)]
pub struct Surface {
    pub label: &'static str,
    pub icon: &'static str,
    /// On the rail's top; false keeps it to its own button (Settings, Modules).
    pub rail: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: &'static str,
    pub name: &'static str,
    /// One line under the name: who provides it, what it is.
    pub summary: &'static str,
    pub description: &'static str,
    pub icon: &'static str,
    /// A `--module-*` hue in the interface's tokens.
    pub hue: &'static str,
    pub kind: &'static str,
    pub source: &'static str,
    /// Part of the shell itself: always on.
    pub core: bool,
    pub surface: Option<Surface>,
    /// Palette command ids this module owns; the palette hides them while it is off.
    pub commands: &'static [&'static str],
    /// Lands items in Today.
    pub items: bool,
    /// Drives the attention pill and stack.
    pub signals: bool,
    pub needs: &'static [Need],
    /// IPC commands this module owns, by exact name or by a prefix ending in
    /// `_`, each with the permission it exercises.
    #[serde(skip)]
    pub invokes: &'static [(&'static str, Permission)],
}

const fn need(permission: Permission, scope: &'static str) -> Need {
    Need { permission, scope }
}

const fn surface(label: &'static str, icon: &'static str) -> Option<Surface> {
    Some(Surface {
        label,
        icon,
        rail: true,
    })
}

const fn own_button(label: &'static str, icon: &'static str) -> Option<Surface> {
    Some(Surface {
        label,
        icon,
        rail: false,
    })
}

use Permission::*;

/// Relay's own capabilities. Rail order follows this list.
pub static BUILT_IN: &[Manifest] = &[
    Manifest {
        id: "today",
        name: "Today",
        summary: "Built in · triage",
        description: "Everything other modules report, in one list: what needs you, what is happening, and quiet updates.",
        icon: "house",
        hue: "relay",
        kind: "native",
        source: "built-in",
        core: true,
        surface: surface("Today", "house"),
        commands: &[],
        items: false,
        signals: false,
        needs: &[],
        invokes: &[],
    },
    Manifest {
        id: "linear",
        name: "Linear",
        summary: "Issues · your assigned work",
        description: "Your assigned issues, projects and cycles from Linear.",
        icon: "inbox",
        hue: "linear",
        kind: "native",
        source: "built-in",
        core: false,
        surface: surface("My work", "inbox"),
        commands: &["relay.linear.open"],
        items: false,
        signals: false,
        needs: &[need(Network, "api.linear.app")],
        invokes: &[("linear_", Network)],
    },
    Manifest {
        id: "agents",
        name: "Agents",
        summary: "Codex and Claude Code",
        description: "Codex threads and Claude Code sessions in your workspaces, in one place: pick the agent, its model and how hard it thinks. Claude reads freely and asks before every edit or command; Codex works inside its workspace sandbox.",
        icon: "sparkles",
        hue: "agents",
        kind: "cli",
        source: "built-in",
        core: false,
        surface: surface("Agents", "sparkles"),
        commands: &["relay.agents.open"],
        items: true,
        signals: true,
        needs: &[
            need(Shell, "the Codex and Claude Code CLIs; Claude's commands ask you first"),
            need(Files, "workspaces; your Codex threads and Claude Code sessions"),
            need(Network, "OpenAI and Anthropic, through the CLIs"),
        ],
        invokes: &[("codex_", Shell), ("claude_", Shell)],
    },
    Manifest {
        id: "terminal",
        name: "Terminal",
        summary: "Built in · your shell",
        description: "Shells in pseudo-terminals, one per tab, in any folder: PowerShell on Windows, your login shell elsewhere.",
        icon: "terminal",
        hue: "flow",
        kind: "native",
        source: "built-in",
        core: false,
        surface: surface("Terminal", "terminal"),
        commands: &["relay.terminal.open"],
        items: false,
        signals: false,
        needs: &[
            need(Shell, "your shell, as you"),
            need(Files, "whatever your shell can reach"),
        ],
        invokes: &[("terminal_", Shell)],
    },
    Manifest {
        id: "projects",
        name: "Projects",
        summary: "Built in · workspaces and scripts",
        description: "Your local workspaces, their GitHub repositories and Linear projects, and their package scripts.",
        icon: "folder",
        hue: "files",
        kind: "native",
        source: "built-in",
        core: false,
        surface: surface("Projects", "folder"),
        commands: &["relay.projects.open"],
        items: true,
        signals: true,
        needs: &[need(Files, "workspaces"), need(Shell, "package scripts, terminals")],
        invokes: &[
            ("project_action", Shell),
            ("project_script_start", Shell),
            ("open_terminal", Shell),
        ],
    },
    Manifest {
        id: "vault",
        name: "Vault",
        summary: "Built in · encrypted",
        description: "Passwords and secrets, encrypted on this device and synced through Nexus.",
        icon: "lock",
        hue: "vault",
        kind: "native",
        source: "built-in",
        core: false,
        surface: surface("Vault", "lock"),
        commands: &["relay.vault.open"],
        items: false,
        signals: false,
        needs: &[need(Vault, "its own entries"), need(Network, "Nexus sync")],
        invokes: &[
            ("vault_", Vault),
            ("generate_password", Vault),
            ("nexus_vault_", Network),
        ],
    },
    Manifest {
        id: "runtime",
        name: "Runtime",
        summary: "Leaf, Nexus, Grafana",
        description: "Health of the services Relay depends on, read from Leaf, Nexus and Grafana.",
        icon: "activity",
        hue: "runtime",
        kind: "native",
        source: "built-in",
        core: false,
        surface: surface("Runtime", "activity"),
        commands: &["relay.runtime.open"],
        items: false,
        signals: false,
        needs: &[need(Network, "read only · Leaf, Nexus, Grafana")],
        invokes: &[("runtime_", Network)],
    },
    Manifest {
        id: "github",
        name: "GitHub",
        summary: "Pull requests, checks, notifications",
        description: "Watches your repositories through Nexus and reports reviews and checks.",
        icon: "git-pull-request",
        hue: "github",
        kind: "native",
        source: "built-in",
        core: false,
        surface: None,
        commands: &["relay.github.open"],
        items: true,
        signals: true,
        needs: &[need(Network, "api.github.com, Nexus events")],
        invokes: &[("github_", Network)],
    },
    Manifest {
        id: "gmail",
        name: "Mail",
        summary: "Gmail",
        description: "New mail in your Gmail inbox, reported to Today and the attention stack.",
        icon: "mail",
        hue: "mail",
        kind: "native",
        source: "built-in",
        core: false,
        surface: None,
        commands: &[],
        items: true,
        signals: true,
        needs: &[need(Mail, "read your inbox"), need(Network, "gmail.googleapis.com")],
        invokes: &[("gmail_", Mail)],
    },
    Manifest {
        id: "opencloud",
        name: "OpenCloud",
        summary: "Files · your OpenCloud space",
        description: "Files in your OpenCloud space: list, upload, download.",
        icon: "folder",
        hue: "files",
        kind: "native",
        source: "built-in",
        core: false,
        surface: None,
        commands: &[],
        items: false,
        signals: false,
        needs: &[need(Network, "your OpenCloud server"), need(Files, "files you pick")],
        invokes: &[("opencloud_", Network)],
    },
    Manifest {
        id: "modules",
        name: "Modules",
        summary: "Built in · this screen",
        description: "Every capability Relay has, what it gives and what it needs.",
        icon: "blocks",
        hue: "relay",
        kind: "native",
        source: "built-in",
        core: true,
        surface: own_button("Modules", "blocks"),
        commands: &[],
        items: false,
        signals: false,
        needs: &[],
        invokes: &[],
    },
    Manifest {
        id: "settings",
        name: "Settings",
        summary: "Built in",
        description: "General settings and connector accounts.",
        icon: "settings",
        hue: "relay",
        kind: "native",
        source: "built-in",
        core: true,
        surface: own_button("Settings", "settings"),
        commands: &["relay.window.settings"],
        items: false,
        signals: false,
        needs: &[],
        invokes: &[],
    },
    Manifest {
        id: "account",
        name: "Nexus",
        summary: "Built in · account and sync",
        description: "Your Nexus identity, which signs Relay in and carries sync between devices.",
        icon: "user",
        hue: "relay",
        kind: "native",
        source: "built-in",
        core: true,
        surface: own_button("Account", "user"),
        commands: &[],
        items: false,
        signals: false,
        needs: &[need(Network, "nexus.eresea.net")],
        invokes: &[],
    },
];

const OFF_KEY: &str = "modules.off";

pub fn get(id: &str) -> Option<&'static Manifest> {
    BUILT_IN.iter().find(|m| m.id == id)
}

fn claims(pattern: &str, command: &str) -> bool {
    if pattern.ends_with('_') {
        command.starts_with(pattern)
    } else {
        command == pattern
    }
}

/// Decides whether an IPC command may run. A command no module claims
/// belongs to the shell (windows, notifications, Nexus sign-in) and always
/// runs. Pure, so the rule is testable without a running app.
pub fn check(command: &str, is_enabled: impl Fn(&Manifest) -> bool) -> Result<()> {
    let claim = BUILT_IN.iter().find_map(|module| {
        module
            .invokes
            .iter()
            .find(|(pattern, _)| claims(pattern, command))
            .map(|(_, permission)| (module, *permission))
    });
    let Some((module, permission)) = claim else {
        return Ok(());
    };
    if !is_enabled(module) {
        return Err(Error::ModuleOff(module.name));
    }
    if !module.needs.iter().any(|n| n.permission == permission) {
        return Err(Error::ModulePermission {
            module: module.name,
            permission,
        });
    }
    Ok(())
}

fn off(app: &AppHandle) -> HashSet<String> {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get(OFF_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// Pinned web apps, each a module of its own (see `webapps.rs`).
fn pinned(app: &AppHandle) -> Vec<crate::webapps::WebApp> {
    crate::webapps::list(app)
}

fn is_pinned(app: &AppHandle, id: &str) -> bool {
    pinned(app).iter().any(|web| web.module_id() == id)
}

pub fn is_enabled(app: &AppHandle, id: &str) -> bool {
    match get(id) {
        Some(module) => module.core || !off(app).contains(id),
        None => is_pinned(app, id) && !off(app).contains(id),
    }
}

/// The gate every IPC call passes through; see [`check`].
pub fn check_invoke(app: &AppHandle, command: &str) -> Result<()> {
    let off = off(app);
    check(command, |m| m.core || !off.contains(m.id))
}

#[derive(Serialize)]
pub struct ModuleInfo {
    #[serde(flatten)]
    manifest: &'static Manifest,
    enabled: bool,
}

/// Built-in modules, then pinned web apps, in the manifest's wire shape.
pub fn list(app: &AppHandle) -> Vec<serde_json::Value> {
    let off = off(app);
    let built_in = BUILT_IN.iter().map(|manifest| {
        serde_json::json!(ModuleInfo {
            manifest,
            enabled: manifest.core || !off.contains(manifest.id),
        })
    });
    let web = pinned(app).into_iter().map(|web| {
        let id = web.module_id();
        serde_json::json!({
            "id": id,
            "name": web.name,
            "summary": format!("Pinned web app · {}", web.host()),
            "description": format!("{} in a tab of its own, signed in apart from everything else.", web.url),
            "icon": "globe",
            "hue": "relay",
            "kind": "web",
            "source": "pinned",
            "core": false,
            "surface": { "label": web.name, "icon": "globe", "rail": true },
            "commands": [],
            "items": false,
            "signals": false,
            "needs": [{ "permission": "network", "scope": web.host() }],
            "enabled": !off.contains(&id),
            "url": web.url,
        })
    });
    built_in.chain(web).collect()
}

/// Turns a module on or off, stops or resumes its background work, and tells
/// every window so each redraws its rail, Today and palette.
pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<()> {
    match get(id) {
        Some(module) if module.core => return Err(Error::CoreModule(module.name)),
        Some(_) => {}
        None if is_pinned(app, id) => {}
        None => return Err(Error::UnknownModule(id.to_owned())),
    }
    let mut off = off(app);
    let changed = if enabled {
        off.remove(id)
    } else {
        off.insert(id.to_owned())
    };
    if !changed {
        return Ok(());
    }
    let mut stored: Vec<&String> = off.iter().collect();
    stored.sort();
    app.store("settings.json")
        .map_err(|error| Error::Settings(error.to_string()))?
        .set(OFF_KEY, serde_json::json!(stored));

    apply_background(app, id, enabled);
    EventSink::emit(app, AppEvent::ModulesChanged);
    Ok(())
}

/// Background work belongs to its module: an off module polls nothing.
fn apply_background(app: &AppHandle, id: &str, enabled: bool) {
    if let (false, Some(web)) = (enabled, id.strip_prefix(crate::webapps::MODULE_PREFIX)) {
        let _ = crate::webapps::close(app, web);
        return;
    }
    match id {
        "gmail" => {
            let registry = app.state::<crate::jobs::JobRegistry>().inner().clone();
            if enabled {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::gmail::resume(
                        app,
                        registry,
                        crate::gmail::HttpGoogleApi::new(),
                        crate::gmail::OsKeyStore,
                    )
                    .await
                    {
                        log::warn!("could not resume the Gmail connector: {error}");
                    }
                });
            } else {
                crate::gmail::pause(app, &registry);
            }
        }
        "github" => crate::nexus_auth::set_events(app, enabled),
        _ => {}
    }
}

#[tauri::command]
pub fn modules_list(app: AppHandle) -> Vec<serde_json::Value> {
    list(&app)
}

#[tauri::command]
pub fn modules_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<()> {
    set_enabled(&app, &id, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_claimed_command_is_declared_by_its_module() {
        for module in BUILT_IN {
            for (pattern, permission) in module.invokes {
                assert!(
                    module.needs.iter().any(|n| n.permission == *permission),
                    "{} claims `{pattern}` with {permission:?} but never declares it",
                    module.id
                );
            }
        }
    }

    #[test]
    fn ids_commands_and_claims_are_unique() {
        let mut ids = HashSet::new();
        let mut commands = HashSet::new();
        let mut patterns = HashSet::new();
        for module in BUILT_IN {
            assert!(ids.insert(module.id), "duplicate module {}", module.id);
            for command in module.commands {
                assert!(commands.insert(*command), "{command} owned twice");
            }
            for (pattern, _) in module.invokes {
                assert!(patterns.insert(*pattern), "{pattern} claimed twice");
            }
        }
    }

    #[test]
    fn an_off_module_cannot_be_invoked() {
        let off = |m: &Manifest| m.core || m.id != "linear";
        assert!(matches!(
            check("linear_my_issues", off),
            Err(Error::ModuleOff("Linear"))
        ));
        assert!(check("github_status", off).is_ok());
        // The shell's own commands are never gated.
        assert!(check("notifications_list", off).is_ok());
        assert!(check("modules_set_enabled", |_| false).is_ok());
    }

    #[test]
    fn exact_claims_do_not_match_by_prefix() {
        let none = |m: &Manifest| m.core;
        assert!(check("open_terminal", none).is_err());
        assert!(check("open_terminal_elsewhere", none).is_ok());
        assert!(check("vault_status", none).is_err());
        assert!(check("nexus_vault_latest", none).is_err());
        assert!(check("nexus_auth_status", none).is_ok());
    }

    #[test]
    fn manifests_serialise_for_the_interface() {
        let json = serde_json::to_value(get("vault").unwrap()).unwrap();
        assert_eq!(json["surface"]["rail"], true);
        assert_eq!(json["needs"][0]["permission"], "vault");
        assert!(json.get("invokes").is_none());
    }
}
