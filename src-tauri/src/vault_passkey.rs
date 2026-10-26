//! Unlocking the Vault with Windows Hello instead of the master password.
//!
//! Windows Hello keeps an RSA key in the TPM that signs only after your
//! face, fingerprint or PIN. Relay asks it to sign a random challenge stored
//! next to the vault; PKCS#1 v1.5 signatures are deterministic, so the same
//! key always gives the same signature, and its SHA-256 is the key that wraps
//! the vault key (AES-256-GCM). The signature never touches disk, so the
//! wrap file alone opens nothing.
//!
//! The wrap lives only on this device (`vault-passkey.json`) and is never
//! synced. The master password keeps working; it stays the way back if
//! Windows Hello is reset. When the vault's key changes (a new master
//! password, or a synced vault applied here), the stored salt no longer
//! matches and Hello unlock says so instead of failing silently.

use std::fs;
use std::path::PathBuf;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::vault::{self, VaultState, KEY_LEN, SALT_LEN};

const WRAP_FILE: &str = "vault-passkey.json";
/// The Vault's Windows Hello credential; one per Windows account.
pub const VAULT_HELLO: WindowsHello = WindowsHello("Relay Vault");
const CHALLENGE_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// Signs with a user-verified device key. Windows Hello in the app; a
/// fixed fake in tests.
pub trait Hello {
    fn available(&self) -> bool;
    /// Creates (or replaces) the credential. Prompts.
    fn create(&self) -> Result<()>;
    /// Signs `challenge` with the credential. Prompts.
    fn sign(&self, challenge: &[u8]) -> Result<Vec<u8>>;
    fn delete(&self);
}

#[derive(Debug, Serialize, Deserialize)]
struct WrapFile {
    version: u8,
    /// The vault salt this wrap belongs to; a different one means the key changed.
    salt: String,
    challenge: String,
    nonce: String,
    wrapped: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyStatus {
    /// Windows Hello is set up on this device.
    pub available: bool,
    /// Hello unlock was set up for a vault here.
    pub enrolled: bool,
    /// It still matches the vault's current key.
    pub current: bool,
}

fn wrap_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(WRAP_FILE))
}

fn read_wrap(app: &AppHandle) -> Result<Option<WrapFile>> {
    let path = wrap_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(path)?;
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|error| Error::VaultCorrupt(format!("Windows Hello unlock data: {error}")))
}

fn wrapping_key(signature: &[u8]) -> [u8; KEY_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(b"relay vault windows-hello v1");
    hasher.update(signature);
    hasher.finalize().into()
}

fn wrap(signature: &[u8], key: &[u8; KEY_LEN]) -> Result<(String, String)> {
    let mut kek = wrapping_key(signature);
    let cipher = Aes256Gcm::new_from_slice(&kek).map_err(|_| Error::Crypto);
    kek.zeroize();
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let wrapped = cipher?
        .encrypt(Nonce::from_slice(&nonce), key.as_slice())
        .map_err(|_| Error::Crypto)?;
    Ok((BASE64.encode(nonce), BASE64.encode(wrapped)))
}

fn unwrap(signature: &[u8], file: &WrapFile) -> Result<[u8; KEY_LEN]> {
    let corrupt = |what: &str| Error::VaultCorrupt(format!("Windows Hello unlock data: {what}"));
    let nonce = BASE64.decode(&file.nonce).map_err(|_| corrupt("nonce"))?;
    let wrapped = BASE64.decode(&file.wrapped).map_err(|_| corrupt("key"))?;
    if nonce.len() != NONCE_LEN {
        return Err(corrupt("nonce length"));
    }
    let mut kek = wrapping_key(signature);
    let cipher = Aes256Gcm::new_from_slice(&kek).map_err(|_| Error::Crypto);
    kek.zeroize();
    let mut plain = cipher?
        .decrypt(Nonce::from_slice(&nonce), wrapped.as_slice())
        // A different signature: the Hello key was replaced or reset.
        .map_err(|_| Error::PasskeyStale)?;
    let key = <[u8; KEY_LEN]>::try_from(plain.as_slice()).map_err(|_| corrupt("key length"));
    plain.zeroize();
    key
}

pub fn status(app: &AppHandle, hello: &impl Hello) -> Result<PasskeyStatus> {
    let wrap = read_wrap(app)?;
    let current = match (&wrap, vault::stored_salt(app)) {
        (Some(wrap), Ok(salt)) => wrap.salt == BASE64.encode(salt),
        _ => false,
    };
    Ok(PasskeyStatus {
        available: hello.available(),
        enrolled: wrap.is_some(),
        current,
    })
}

/// Sets up Hello unlock for the open vault. Prompts for Windows Hello.
pub fn enroll(app: &AppHandle, state: &VaultState, hello: &impl Hello) -> Result<()> {
    if !hello.available() {
        return Err(Error::PasskeyUnavailable);
    }
    let (mut key, salt) = vault::current_key(state)?;
    let result = (|| {
        hello.create()?;
        let mut challenge = [0u8; CHALLENGE_LEN];
        OsRng.fill_bytes(&mut challenge);
        let mut signature = hello.sign(&challenge)?;
        let wrapped = wrap(&signature, &key);
        signature.zeroize();
        let (nonce, wrapped) = wrapped?;
        let file = WrapFile {
            version: 1,
            salt: BASE64.encode::<[u8; SALT_LEN]>(salt),
            challenge: BASE64.encode(challenge),
            nonce,
            wrapped,
        };
        let raw = serde_json::to_vec(&file).map_err(|e| Error::VaultCorrupt(e.to_string()))?;
        fs::write(wrap_path(app)?, raw)?;
        Ok(())
    })();
    key.zeroize();
    result
}

/// Opens the vault with Windows Hello. Prompts.
pub fn unlock(app: &AppHandle, state: &VaultState, hello: &impl Hello) -> Result<()> {
    let wrap = read_wrap(app)?.ok_or(Error::PasskeyNotEnrolled)?;
    if wrap.salt != BASE64.encode(vault::stored_salt(app)?) {
        return Err(Error::PasskeyStale);
    }
    let challenge = BASE64
        .decode(&wrap.challenge)
        .map_err(|_| Error::VaultCorrupt("Windows Hello unlock data: challenge".into()))?;
    let mut signature = hello.sign(&challenge)?;
    let key = unwrap(&signature, &wrap);
    signature.zeroize();
    vault::unlock_with_key(app, state, key?).map_err(|error| match error {
        // The salt matched but the key does not open the vault.
        Error::WrongMasterPassword | Error::Crypto => Error::PasskeyStale,
        other => other,
    })
}

/// Forgets Hello unlock on this device. The master password is untouched.
pub fn remove(app: &AppHandle, hello: &impl Hello) -> Result<()> {
    let path = wrap_path(app)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    hello.delete();
    Ok(())
}

#[cfg(windows)]
pub use windows_hello::WindowsHello;

#[cfg(windows)]
mod windows_hello {
    use windows::core::{Array, HSTRING};
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;

    use super::Hello;
    use crate::error::{Error, Result};

    /// Windows Hello through `KeyCredentialManager`: a TPM-backed key that
    /// signs only after the user verifies. Holds the credential's name.
    pub struct WindowsHello(pub &'static str);

    fn failed(error: windows::core::Error) -> Error {
        Error::PasskeyFailed(error.message().to_string())
    }

    fn check(status: KeyCredentialStatus) -> Result<()> {
        match status {
            KeyCredentialStatus::Success => Ok(()),
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => {
                Err(Error::PasskeyCancelled)
            }
            KeyCredentialStatus::NotFound => Err(Error::PasskeyNotEnrolled),
            other => Err(Error::PasskeyFailed(format!(
                "Windows Hello said {other:?}"
            ))),
        }
    }

    impl Hello for WindowsHello {
        fn available(&self) -> bool {
            KeyCredentialManager::IsSupportedAsync()
                .and_then(|operation| operation.get())
                .unwrap_or(false)
        }

        fn create(&self) -> Result<()> {
            let result = KeyCredentialManager::RequestCreateAsync(
                &HSTRING::from(self.0),
                KeyCredentialCreationOption::ReplaceExisting,
            )
            .and_then(|operation| operation.get())
            .map_err(failed)?;
            check(result.Status().map_err(failed)?)
        }

        fn sign(&self, challenge: &[u8]) -> Result<Vec<u8>> {
            let opened = KeyCredentialManager::OpenAsync(&HSTRING::from(self.0))
                .and_then(|operation| operation.get())
                .map_err(failed)?;
            check(opened.Status().map_err(failed)?)?;
            let data = CryptographicBuffer::CreateFromByteArray(challenge).map_err(failed)?;
            let signed = opened
                .Credential()
                .and_then(|credential| credential.RequestSignAsync(&data))
                .and_then(|operation| operation.get())
                .map_err(failed)?;
            check(signed.Status().map_err(failed)?)?;
            let mut signature = Array::<u8>::new();
            CryptographicBuffer::CopyToByteArray(&signed.Result().map_err(failed)?, &mut signature)
                .map_err(failed)?;
            Ok(signature.to_vec())
        }

        fn delete(&self) {
            let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(self.0))
                .and_then(|operation| operation.get());
        }
    }
}

/// Elsewhere there is no Windows Hello; everything says so.
#[cfg(not(windows))]
pub struct WindowsHello(#[allow(dead_code)] pub &'static str);

#[cfg(not(windows))]
impl Hello for WindowsHello {
    fn available(&self) -> bool {
        false
    }
    fn create(&self) -> Result<()> {
        Err(Error::PasskeyUnavailable)
    }
    fn sign(&self, _challenge: &[u8]) -> Result<Vec<u8>> {
        Err(Error::PasskeyUnavailable)
    }
    fn delete(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_wraps_and_unwraps_the_key_and_no_other_does() {
        let key = [7u8; KEY_LEN];
        let signature = vec![42u8; 256];
        let (nonce, wrapped) = wrap(&signature, &key).unwrap();
        let file = WrapFile {
            version: 1,
            salt: String::new(),
            challenge: String::new(),
            nonce,
            wrapped,
        };
        assert_eq!(unwrap(&signature, &file).unwrap(), key);
        assert!(matches!(
            unwrap(&[43u8; 256], &file),
            Err(Error::PasskeyStale)
        ));
        // The wrap file holds no key material in the clear.
        assert!(!serde_json::to_string(&file)
            .unwrap()
            .contains(&BASE64.encode(key)));
    }

    #[test]
    fn the_wrapping_key_is_not_the_signature() {
        let signature = [1u8; 64];
        assert_ne!(wrapping_key(&signature).as_slice(), &signature[..KEY_LEN]);
        assert_eq!(wrapping_key(&signature), wrapping_key(&signature));
    }

    /// Asks Windows Hello three times (create, then two signatures), so it
    /// only runs on purpose: `cargo test live_windows_hello -- --ignored`.
    /// Proves what unlock rests on: the same key signs the same challenge
    /// identically, every time. Uses its own credential, never the Vault's.
    #[cfg(windows)]
    #[test]
    #[ignore = "prompts for Windows Hello"]
    fn live_windows_hello_signs_the_same_challenge_the_same_way() {
        let hello = WindowsHello("Relay Vault test");
        assert!(
            hello.available(),
            "Windows Hello is not set up on this device"
        );
        hello.create().unwrap();
        let challenge = [9u8; CHALLENGE_LEN];
        let first = hello.sign(&challenge).unwrap();
        let second = hello.sign(&challenge).unwrap();
        hello.delete();
        println!("signature: {} bytes", first.len());
        assert!(first.len() >= 256);
        assert_eq!(first, second);
    }
}
