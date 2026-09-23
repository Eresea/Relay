use semver::Version;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const RELEASE_API: &str = "https://api.github.com/repos/Eresea/Relay/releases/latest";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileUpdate {
    pub current_version: String,
    pub latest_version: String,
    pub apk_url: String,
    pub release_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

pub async fn check() -> Result<Option<MobileUpdate>> {
    let current_version = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| Error::MobileUpdateVersion(error.to_string()))?;
    let release = reqwest::Client::new()
        .get(RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(reqwest::header::USER_AGENT, "relay-mobile-updater")
        .send()
        .await?
        .error_for_status()?
        .json::<GithubRelease>()
        .await?;
    let latest_version_text = release.tag_name.trim_start_matches('v');
    let latest_version = Version::parse(latest_version_text)
        .map_err(|error| Error::MobileUpdateVersion(error.to_string()))?;

    if latest_version <= current_version {
        return Ok(None);
    }

    let apk_url = release
        .assets
        .into_iter()
        .find(|asset| asset.name.to_ascii_lowercase().ends_with(".apk"))
        .map(|asset| asset.browser_download_url)
        .ok_or(Error::MobileUpdateApkMissing)?;

    Ok(Some(MobileUpdate {
        current_version: current_version.to_string(),
        latest_version: latest_version.to_string(),
        apk_url,
        release_url: release.html_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_a_release_that_is_not_newer() {
        assert!(Version::parse("0.1.1").unwrap() <= Version::parse("0.1.1").unwrap());
        assert!(Version::parse("0.1.0").unwrap() < Version::parse("0.1.1").unwrap());
    }
}
