//! meka, as mekaweb reaches it: its address, the token every request to it carries, and how it
//! stands (reachable or not, and whether its version is one this release supports). The versions
//! come from `web/src/api/meka-versions.json`, which the interface reads too.

use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use url::Url;
use utoipa::ToSchema;

use crate::config::{Config, MekaToken};

/// The meka versions this release supports, shared with the interface.
const VERSIONS: &str = include_str!("../../../web/src/api/meka-versions.json");

/// How long connecting to meka may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a check of meka's version may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// How often meka is checked while it answers.
const CHECK_EVERY: Duration = Duration::from_secs(60);

/// How often meka is checked while it does not.
const RETRY_EVERY: Duration = Duration::from_secs(5);

/// The meka versions this release supports.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub(crate) struct Versions {
    /// The oldest meka it works with.
    pub(crate) minimum: String,
    /// The versions it was checked against.
    pub(crate) verified: Vec<String>,
}

/// The versions in [`VERSIONS`].
pub(crate) fn versions() -> anyhow::Result<Versions> {
    Ok(serde_json::from_str(VERSIONS)?)
}

/// `version` as numbers, if it is `major.minor.patch` with maybe a build after a `+`.
fn numbers(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split_once('+').map_or(version, |(core, _)| core);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

/// Whether meka `version` is `minimum` or newer.
pub(crate) fn is_supported(version: &str, minimum: &str) -> bool {
    match (numbers(version), numbers(minimum)) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}

/// How meka stands.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub(crate) struct MekaStatus {
    /// Whether meka answered the last check.
    pub(crate) reachable: bool,
    /// meka's version, when it answered.
    pub(crate) version: Option<String>,
    /// Whether that version is one this release works with.
    pub(crate) supported: bool,
    /// Whether that version is one this release was checked against.
    pub(crate) verified: bool,
    /// Why the last check failed, when it did.
    pub(crate) error: Option<String>,
    /// When meka was last checked.
    pub(crate) checked_at: Option<DateTime<Utc>>,
}

/// meka, as mekaweb reaches it.
pub(crate) struct Meka {
    url: Url,
    /// The file the token is read from, unless the config holds it.
    token_file: Option<std::path::PathBuf>,
    token: RwLock<String>,
    client: reqwest::Client,
    status: RwLock<MekaStatus>,
    versions: Versions,
    recheck: Notify,
}

impl Meka {
    /// meka as `config` says to reach it.
    pub(crate) fn new(config: &Config) -> anyhow::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Arc::new(Self {
            url: config.meka.url.clone(),
            token_file: match &config.meka.token {
                MekaToken::File(file) => Some(file.clone()),
                MekaToken::Inline(_) => None,
            },
            token: RwLock::new(config.meka_token()?),
            client,
            status: RwLock::new(MekaStatus::default()),
            versions: versions()?,
            recheck: Notify::new(),
        }))
    }

    /// The HTTP client requests to meka go through.
    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// The address of meka's `path`, which starts with `/`.
    pub(crate) fn url(&self, path: &str) -> anyhow::Result<Url> {
        Ok(self.url.join(path.trim_start_matches('/'))?)
    }

    /// meka's address.
    pub(crate) fn base(&self) -> &Url {
        &self.url
    }

    /// The token requests to meka carry.
    pub(crate) fn token(&self) -> String {
        self.token
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Reads the token file again, if there is one, so a token changed there is used without a
    /// restart.
    fn reload_token(&self) {
        let Some(file) = &self.token_file else {
            return;
        };
        match std::fs::read_to_string(file) {
            Ok(token) if !token.trim().is_empty() => {
                *self
                    .token
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = token.trim().to_owned();
            }
            Ok(_) => tracing::warn!("the meka token file is empty; keeping the token read before"),
            Err(error) => tracing::warn!("could not read the meka token file again: {error}"),
        }
    }

    /// How meka stood at the last check.
    pub(crate) fn status(&self) -> MekaStatus {
        self.status
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The versions this release supports.
    pub(crate) fn versions(&self) -> &Versions {
        &self.versions
    }

    /// Notes that a request to meka failed to connect, and checks it again soon.
    pub(crate) fn lost(&self, error: &str) {
        let mut status = self
            .status
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if status.reachable {
            tracing::warn!("meka stopped answering: {error}");
            status.reachable = false;
            status.error = Some(error.to_owned());
            drop(status);
            self.recheck.notify_one();
        }
    }

    /// Notes that a request to meka was answered; checks its version again if it had been lost.
    pub(crate) fn answered(&self) {
        let lost = !self
            .status
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reachable;
        if lost {
            self.recheck.notify_one();
        }
    }

    /// Checks meka once: whether it answers, and with which version.
    pub(crate) async fn check(&self) -> MekaStatus {
        self.reload_token();
        let previous = self.status();
        let mut status = MekaStatus {
            checked_at: Some(Utc::now()),
            ..MekaStatus::default()
        };
        let result = async {
            let response = self
                .client
                .get(self.url("/v1/info")?)
                .bearer_auth(self.token())
                .timeout(CHECK_TIMEOUT)
                .send()
                .await?;
            let response = response.error_for_status()?;
            let info: serde_json::Value = response.json().await?;
            info.get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("meka's /v1/info did not say its version"))
        }
        .await;
        match result {
            Ok(version) => {
                status.reachable = true;
                status.supported = is_supported(&version, &self.versions.minimum);
                status.verified = self.versions.verified.contains(&version);
                if !status.supported {
                    tracing::warn!(
                        "meka {version} is older than {}, the oldest this mekaweb supports",
                        self.versions.minimum
                    );
                } else if previous.version.as_deref() != Some(version.as_str())
                    || !previous.reachable
                {
                    tracing::info!(
                        "meka {version} answers{}",
                        if status.verified {
                            ""
                        } else {
                            ", a version this release was not checked against"
                        }
                    );
                }
                status.version = Some(version);
            }
            Err(error) => {
                if previous.reachable || previous.checked_at.is_none() {
                    tracing::warn!("meka does not answer at {}: {error:#}", self.url);
                }
                status.error = Some(format!("{error:#}"));
                // What it was is still the best word on what it is.
                status.version = previous.version;
                status.supported = previous.supported;
                status.verified = previous.verified;
            }
        }
        *self
            .status
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = status.clone();
        status
    }

    /// Checks meka now and then for as long as mekaweb runs.
    pub(crate) async fn watch(self: Arc<Self>) {
        loop {
            let status = self.check().await;
            let wait = if status.reachable {
                CHECK_EVERY
            } else {
                RETRY_EVERY
            };
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.recheck.notified() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_versions_read() {
        let versions = versions().unwrap();
        assert!(numbers(&versions.minimum).is_some());
        assert!(
            versions
                .verified
                .iter()
                .all(|version| numbers(version).is_some())
        );
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(is_supported("0.83.0", "0.83.0"));
        assert!(is_supported("0.83.1", "0.83.0"));
        assert!(is_supported("0.100.0", "0.83.0"));
        assert!(is_supported("1.0.0", "0.83.0"));
        assert!(is_supported("0.83.0+build.1", "0.83.0"));
        assert!(!is_supported("0.82.9", "0.83.0"));
        assert!(!is_supported("0.83.0-rc.1", "0.83.0"));
        assert!(!is_supported("0.83", "0.83.0"));
        assert!(!is_supported("unknown", "0.83.0"));
    }
}
