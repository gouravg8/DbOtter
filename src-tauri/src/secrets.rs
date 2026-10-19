//! Passwords in the OS credential store: Keychain on macOS, Credential Manager on Windows,
//! Secret Service (GNOME Keyring, KWallet) on Linux.

use crate::error::{AppError, AppResult};

pub struct Secrets {
    service: String,
}

fn keychain_error(action: &str, e: keyring::Error) -> AppError {
    AppError::new(format!("Couldn't {action} the system keychain: {e}")).with_code("keychain")
}

impl Secrets {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(service: &str, id: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(service, id).map_err(|e| keychain_error("open", e))
    }

    // The keychain APIs block (D-Bus round trips on Linux), so they run off the async runtime.

    pub async fn get(&self, id: &str) -> AppResult<Option<String>> {
        let (service, id) = (self.service.clone(), id.to_string());
        tokio::task::spawn_blocking(move || match Self::entry(&service, &id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error("read from", e)),
        })
        .await
        .map_err(|e| AppError::new(e.to_string()))?
    }

    pub async fn set(&self, id: &str, password: &str) -> AppResult<()> {
        let (service, id, password) = (self.service.clone(), id.to_string(), password.to_string());
        tokio::task::spawn_blocking(move || {
            Self::entry(&service, &id)?.set_password(&password).map_err(|e| keychain_error("save to", e))
        })
        .await
        .map_err(|e| AppError::new(e.to_string()))?
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let (service, id) = (self.service.clone(), id.to_string());
        tokio::task::spawn_blocking(move || match Self::entry(&service, &id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error("delete from", e)),
        })
        .await
        .map_err(|e| AppError::new(e.to_string()))?
    }
}
