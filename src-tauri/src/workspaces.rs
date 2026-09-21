use std::cmp::Reverse;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::Result;

const MAX_DEPTH: usize = 4;
const MAX_DIRECTORIES: usize = 5_000;
const MAX_RESULTS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub name: String,
    pub path: String,
    pub github_repo: Option<String>,
    pub modified_at: Option<u64>,
}

/// Finds local Git clones without asking the user to register every folder.
/// The scan is intentionally shallow and bounded: it is a discovery hint, not
/// a file indexer or a background watcher.
pub fn scan() -> Result<Vec<WorkspaceSummary>> {
    let mut queue = scan_roots()
        .into_iter()
        .map(|root| (root, 0))
        .collect::<VecDeque<_>>();
    let mut inspected = 0;
    let mut workspaces = Vec::new();

    while let Some((path, depth)) = queue.pop_front() {
        if inspected >= MAX_DIRECTORIES || workspaces.len() >= MAX_RESULTS {
            break;
        }
        inspected += 1;

        if has_git_metadata(&path) {
            workspaces.push(summary(&path));
            continue;
        }
        if depth >= MAX_DEPTH {
            continue;
        }

        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) && !is_skipped(&child) {
                queue.push_back((child, depth + 1));
            }
        }
    }

    workspaces.sort_by_key(|workspace| {
        (
            Reverse(workspace.modified_at.unwrap_or_default()),
            workspace.path.to_ascii_lowercase(),
        )
    });
    Ok(workspaces)
}

/// Opens the platform terminal in a discovered workspace.
pub fn open_terminal(path: &str) -> Result<()> {
    let path = Path::new(path);
    if !path.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "workspace directory does not exist",
        )
        .into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd.exe").current_dir(path).spawn()?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(path)
            .spawn()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let mut last_error = None;
        for program in [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
        ] {
            match Command::new(program).current_dir(path).spawn() {
                Ok(_) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error
            .unwrap_or_else(|| std::io::Error::other("no terminal emulator found"))
            .into())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opening a terminal is not supported on this platform",
    )
    .into())
}

fn summary(path: &Path) -> WorkspaceSummary {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_str().unwrap_or("Workspace"))
        .to_string();

    WorkspaceSummary {
        name,
        path: path.to_string_lossy().into_owned(),
        github_repo: read_origin(path),
        modified_at: modified_at(path),
    }
}

fn has_git_metadata(path: &Path) -> bool {
    path.join(".git").is_dir() || path.join(".git").is_file()
}

fn read_origin(path: &Path) -> Option<String> {
    let git_config = path.join(".git").join("config");
    let contents = std::fs::read_to_string(git_config).ok()?;
    let mut in_origin = false;

    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line.eq_ignore_ascii_case(r#"[remote "origin"]"#);
            continue;
        }
        if in_origin {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            if key.trim().eq_ignore_ascii_case("url") {
                return github_repo_from_remote(value.trim());
            }
        }
    }
    None
}

fn github_repo_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.split_once("github.com/").map(|(_, path)| path))?;
    let mut segments = path.split('/');
    let owner = segments.next()?.trim();
    let repo = segments.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn modified_at(path: &Path) -> Option<u64> {
    let git_index = path.join(".git").join("index");
    let metadata_path = git_index
        .try_exists()
        .ok()
        .filter(|exists| *exists)
        .map(|_| git_index)
        .unwrap_or_else(|| path.join(".git"));
    std::fs::metadata(metadata_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn is_skipped(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "$recycle.bin"
            | "appdata"
            | "build"
            | "dist"
            | "node_modules"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "target"
            | "system volume information"
            | "windows"
            | ".git"
            | ".venv"
            | "venv"
    )
}

#[cfg(windows)]
fn scan_roots() -> Vec<PathBuf> {
    ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|root| root.is_dir())
        .collect()
}

#[cfg(not(windows))]
fn scan_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_and_ssh_github_remotes() {
        assert_eq!(
            github_repo_from_remote("https://github.com/openai/relay.git"),
            Some("openai/relay".to_string())
        );
        assert_eq!(
            github_repo_from_remote("git@github.com:openai/relay.git"),
            Some("openai/relay".to_string())
        );
    }

    #[test]
    fn ignores_non_github_remotes() {
        assert_eq!(
            github_repo_from_remote("https://gitlab.com/openai/relay.git"),
            None
        );
    }

    #[test]
    fn reads_the_origin_remote_from_a_clone() {
        let root =
            std::env::temp_dir().join(format!("relay-workspace-test-{}", std::process::id()));
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(
            git.join("config"),
            "[remote \"origin\"]\n\turl = git@github.com:openai/relay.git\n",
        )
        .unwrap();

        assert_eq!(read_origin(&root), Some("openai/relay".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_open_a_missing_workspace() {
        let path =
            std::env::temp_dir().join(format!("relay-missing-workspace-{}", std::process::id()));
        assert!(open_terminal(path.to_str().unwrap()).is_err());
    }
}
