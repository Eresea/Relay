//! Small WebDAV client for files in an OpenCloud space.

use std::net::IpAddr;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use percent_encoding::percent_decode_str;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{Client, Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{Error, Result};
use crate::vault::VaultState;

const KEYRING_SERVICE: &str = "dev.relay.opencloud";
const KEYRING_ACCOUNT: &str = "webdav-connection";
const PROPFIND_BODY: &str = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    webdav_url: String,
    username: String,
    app_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCloudStatus {
    connected: bool,
    webdav_url: Option<String>,
    username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCloudItem {
    path: String,
    name: String,
    is_folder: bool,
    size: u64,
    modified: Option<String>,
    media_type: Option<String>,
}

fn keyring_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

fn connection() -> Result<Connection> {
    let raw = keyring_entry()?
        .get_password()
        .map_err(|error| Error::TokenStore(error.to_string()))?;
    serde_json::from_str(&raw).map_err(|error| Error::OpenCloud(error.to_string()))
}

fn validate_webdav_url(value: &str) -> Result<Url> {
    let url = Url::parse(value.trim()).map_err(|error| Error::OpenCloud(error.to_string()))?;
    let is_local_http = url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if (url.scheme() != "https" && !is_local_http)
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::OpenCloud(
            "use an HTTPS WebDAV URL without credentials or query parameters".into(),
        ));
    }
    Ok(url)
}

fn url_for_path(connection: &Connection, path: &str, directory: bool) -> Result<Url> {
    let mut url = validate_webdav_url(&connection.webdav_url)?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| Error::OpenCloud("invalid WebDAV URL".into()))?;
    segments.pop_if_empty();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        if matches!(segment, "." | "..") {
            return Err(Error::OpenCloud("invalid file path".into()));
        }
        segments.push(segment);
    }
    if directory {
        segments.push("");
    }
    drop(segments);
    Ok(url)
}

fn authenticated(client: &Client, connection: &Connection, url: Url) -> reqwest::RequestBuilder {
    client
        .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
        .basic_auth(&connection.username, Some(&connection.app_token))
}

fn http_client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(Error::from)
}

async fn check_response(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() || status == StatusCode::MULTI_STATUS {
        Ok(response)
    } else {
        Err(Error::OpenCloud(format!("server returned HTTP {status}")))
    }
}

pub fn status() -> OpenCloudStatus {
    match connection() {
        Ok(connection) => OpenCloudStatus {
            connected: true,
            webdav_url: Some(connection.webdav_url),
            username: Some(connection.username),
        },
        Err(_) => OpenCloudStatus {
            connected: false,
            webdav_url: None,
            username: None,
        },
    }
}

pub async fn connect(
    vault: &VaultState,
    webdav_url: String,
    username: String,
    app_token: String,
) -> Result<()> {
    crate::vault::ensure_unlocked(vault)?;
    let url = validate_webdav_url(&webdav_url)?;
    let candidate = Connection {
        webdav_url: url.as_str().trim_end_matches('/').to_owned(),
        username: username.trim().to_owned(),
        app_token,
    };
    if candidate.username.is_empty() || candidate.app_token.is_empty() {
        return Err(Error::OpenCloud(
            "enter your OpenCloud username and app token".into(),
        ));
    }
    let client = http_client()?;
    let response = client
        .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
        .basic_auth(&candidate.username, Some(&candidate.app_token))
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await?;
    check_response(response).await?;

    let raw =
        serde_json::to_string(&candidate).map_err(|error| Error::OpenCloud(error.to_string()))?;
    keyring_entry()?
        .set_password(&raw)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

pub fn disconnect() -> Result<()> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

pub async fn list(vault: &VaultState, path: String) -> Result<Vec<OpenCloudItem>> {
    crate::vault::ensure_unlocked(vault)?;
    let connection = connection()?;
    let url = url_for_path(&connection, &path, true)?;
    let client = http_client()?;
    let response = authenticated(&client, &connection, url)
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await?;
    let response = check_response(response).await?;
    let xml = response.text().await?;
    parse_listing(&connection, &path, &xml)
}

pub async fn create_folder(vault: &VaultState, path: String, name: String) -> Result<()> {
    crate::vault::ensure_unlocked(vault)?;
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(Error::OpenCloud("enter a valid folder name".into()));
    }
    let connection = connection()?;
    let url = url_for_path(&connection, &format!("{path}/{name}"), true)?;
    let response = http_client()?
        .request(Method::from_bytes(b"MKCOL").unwrap(), url)
        .basic_auth(&connection.username, Some(&connection.app_token))
        .send()
        .await?;
    check_response(response).await.map(|_| ())
}

pub async fn upload(
    vault: &VaultState,
    path: String,
    name: String,
    media_type: String,
    content_base64: String,
) -> Result<()> {
    crate::vault::ensure_unlocked(vault)?;
    if name.trim().is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
    {
        return Err(Error::OpenCloud("invalid file name".into()));
    }
    let content = BASE64
        .decode(content_base64)
        .map_err(|_| Error::OpenCloud("file data is invalid".into()))?;
    let content = crate::vault::encrypt_file_content(vault, &content)?;
    let connection = connection()?;
    let url = url_for_path(&connection, &format!("{path}/{name}"), false)?;
    let response = http_client()?
        .put(url)
        .basic_auth(&connection.username, Some(&connection.app_token))
        .header("If-None-Match", "*")
        .header(
            "Content-Type",
            if media_type.is_empty() {
                "application/octet-stream"
            } else {
                &media_type
            },
        )
        .body(content)
        .send()
        .await?;
    check_response(response).await.map(|_| ())
}

pub async fn delete(vault: &VaultState, path: String) -> Result<()> {
    crate::vault::ensure_unlocked(vault)?;
    let connection = connection()?;
    let url = url_for_path(&connection, &path, false)?;
    let response = http_client()?
        .delete(url)
        .basic_auth(&connection.username, Some(&connection.app_token))
        .send()
        .await?;
    check_response(response).await.map(|_| ())
}

pub async fn download(vault: &VaultState, path: String) -> Result<String> {
    crate::vault::ensure_unlocked(vault)?;
    let connection = connection()?;
    let url = url_for_path(&connection, &path, false)?;
    let response = http_client()?
        .get(url)
        .basic_auth(&connection.username, Some(&connection.app_token))
        .send()
        .await?;
    let encrypted = check_response(response).await?.bytes().await?;
    let content = crate::vault::decrypt_file_content(vault, &encrypted)?;
    Ok(BASE64.encode(content))
}

#[tauri::command]
pub async fn opencloud_connect(
    vault: tauri::State<'_, VaultState>,
    webdav_url: String,
    username: String,
    app_token: String,
) -> Result<()> {
    connect(vault.inner(), webdav_url, username, app_token).await
}

#[tauri::command]
pub fn opencloud_disconnect(vault: tauri::State<'_, VaultState>) -> Result<()> {
    crate::vault::ensure_unlocked(vault.inner())?;
    disconnect()
}

#[tauri::command]
pub fn opencloud_status() -> OpenCloudStatus {
    status()
}

#[tauri::command]
pub async fn opencloud_list(
    vault: tauri::State<'_, VaultState>,
    path: String,
) -> Result<Vec<OpenCloudItem>> {
    list(vault.inner(), path).await
}

#[tauri::command]
pub async fn opencloud_create_folder(
    vault: tauri::State<'_, VaultState>,
    path: String,
    name: String,
) -> Result<()> {
    create_folder(vault.inner(), path, name).await
}

#[tauri::command]
pub async fn opencloud_upload(
    vault: tauri::State<'_, VaultState>,
    path: String,
    name: String,
    media_type: String,
    content_base64: String,
) -> Result<()> {
    upload(vault.inner(), path, name, media_type, content_base64).await
}

#[tauri::command]
pub async fn opencloud_delete(vault: tauri::State<'_, VaultState>, path: String) -> Result<()> {
    delete(vault.inner(), path).await
}

#[tauri::command]
pub async fn opencloud_download(
    vault: tauri::State<'_, VaultState>,
    path: String,
) -> Result<String> {
    download(vault.inner(), path).await
}

#[derive(Default)]
struct ListingDraft {
    href: String,
    name: String,
    size: u64,
    modified: Option<String>,
    media_type: Option<String>,
    is_folder: bool,
}

fn parse_listing(connection: &Connection, folder: &str, xml: &str) -> Result<Vec<OpenCloudItem>> {
    let root = validate_webdav_url(&connection.webdav_url)?;
    let root_path = root.path().trim_end_matches('/');
    let parent = folder.trim_matches('/');
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut draft: Option<ListingDraft> = None;
    let mut field = String::new();
    let mut items = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = event.local_name().as_ref().to_owned();
                if name == "response" {
                    draft = Some(ListingDraft::default());
                } else if draft.is_some() {
                    field = name;
                }
            }
            Ok(Event::Empty(event)) => {
                let name = event.local_name();
                if name.as_ref() == "collection" {
                    if let Some(draft) = &mut draft {
                        draft.is_folder = true;
                    }
                }
            }
            Ok(Event::Text(event)) if draft.is_some() => {
                let decoded = event.xml10_content();
                let text = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| Error::OpenCloud(error.to_string()))?
                    .into_owned();
                if let Some(draft) = &mut draft {
                    match field.as_str() {
                        "href" => draft.href = text,
                        "displayname" => draft.name = text,
                        "getcontentlength" => draft.size = text.parse().unwrap_or_default(),
                        "getlastmodified" => draft.modified = Some(text),
                        "getcontenttype" => draft.media_type = Some(text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = event.local_name();
                if name.as_ref() == "response" {
                    if let Some(draft) = draft.take() {
                        if let Some(item) = make_item(&root, root_path, parent, draft)? {
                            items.push(item);
                        }
                    }
                } else if field == name.as_ref() {
                    field.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(Error::OpenCloud(error.to_string())),
            _ => {}
        }
    }
    items.sort_by(|a, b| {
        b.is_folder
            .cmp(&a.is_folder)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

fn make_item(
    root: &Url,
    root_path: &str,
    parent: &str,
    draft: ListingDraft,
) -> Result<Option<OpenCloudItem>> {
    if draft.href.is_empty() {
        return Ok(None);
    }
    let item_url = root
        .join(&draft.href)
        .map_err(|error| Error::OpenCloud(error.to_string()))?;
    if item_url.origin() != root.origin() {
        return Err(Error::OpenCloud(
            "server returned an item outside the WebDAV space".into(),
        ));
    }
    let encoded_path = item_url.path();
    let Some(relative_encoded) = encoded_path.strip_prefix(root_path) else {
        return Err(Error::OpenCloud(
            "server returned an item outside the WebDAV space".into(),
        ));
    };
    if !relative_encoded.is_empty() && !relative_encoded.starts_with('/') {
        return Err(Error::OpenCloud(
            "server returned an item outside the WebDAV space".into(),
        ));
    }
    let relative = relative_encoded.trim_matches('/');
    let relative = percent_decode_str(relative)
        .decode_utf8()
        .map_err(|error| Error::OpenCloud(error.to_string()))?
        .into_owned();
    if relative.is_empty() || relative == parent {
        return Ok(None);
    }
    let item_parent = relative
        .rsplit_once('/')
        .map(|(path, _)| path)
        .unwrap_or("");
    if item_parent != parent {
        return Ok(None);
    }
    let name = if draft.name.is_empty() {
        relative.rsplit('/').next().unwrap_or_default().to_owned()
    } else {
        draft.name
    };
    Ok(Some(OpenCloudItem {
        path: relative,
        name,
        is_folder: draft.is_folder,
        size: draft.size,
        modified: draft.modified,
        media_type: draft.media_type,
    }))
}
