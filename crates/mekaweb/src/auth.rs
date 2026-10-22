//! Signing in: the user's password and passkeys, the sign-ins each device holds as a cookie, the
//! rate limits on guessing, and the log of attempts. One user, added from the command line.
//!
//! A sign-in's cookie holds a random token; the database keeps its SHA-256 alone. It is
//! `HttpOnly` and `SameSite=Strict`, and over HTTPS `Secure` with the `__Host-` prefix. It lasts
//! [`IDLE_LIFETIME`] after its last use, up to [`ABSOLUTE_LIFETIME`] in all.

pub(crate) mod limiter;
pub(crate) mod passkeys;
pub(crate) mod password;

use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, header, request::Parts},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use ipnet::IpNet;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use self::{
    limiter::{
        CHALLENGES_PER_ADDRESS, CONFIRMS_PER_DEVICE, Limiter, SIGN_IN_PER_ACCOUNT,
        SIGN_IN_PER_ADDRESS, network,
    },
    passkeys::Passkeys,
    password::Hasher,
};
use crate::{
    app::App,
    config::Config,
    error::ApiError,
    store::{LogEntry, SessionRow, Store, UserRow},
};

/// How long a sign-in lasts after it was last used.
pub(crate) const IDLE_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// How long a sign-in lasts at most, however often it is used.
pub(crate) const ABSOLUTE_LIFETIME: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// How recently someone must have confirmed who they are to add or remove a passkey. Changing the
/// password takes the current one instead.
pub(crate) const FRESH_WINDOW: Duration = Duration::from_secs(10 * 60);

/// How often a connection held open looks whether its sign-in has ended, at least.
const RECHECK_EVERY: Duration = Duration::from_secs(60);

/// How often a sign-in's last use is written down at most.
const TOUCH_EVERY: Duration = Duration::from_secs(60);

/// The sign-in cookie's name, before any prefix.
const SESSION_COOKIE: &str = "mekaweb_session";

/// Who sent a request: their address, as far as it can be trusted, and their browser.
#[derive(Debug, Clone)]
pub(crate) struct Client {
    pub(crate) ip: IpAddr,
    pub(crate) user_agent: String,
}

impl Client {
    /// The client of a request that reached mekaweb from `peer`, believing `X-Forwarded-For` only
    /// from a trusted proxy, and then only its last address that is not itself a trusted proxy:
    /// the one the nearest proxy saw. Cloudflare, Caddy and nginx each append the address they
    /// were reached from, so what a client writes there itself comes earlier and is passed over.
    /// `CF-Connecting-IP` is not read: a proxy that does not set it passes on whatever a client
    /// sent.
    pub(crate) fn from_request(
        headers: &HeaderMap,
        peer: Option<IpAddr>,
        trusted: &[IpNet],
    ) -> Self {
        let user_agent = headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .chars()
            .take(512)
            .collect();
        let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
        let peer = peer.unwrap_or(IpAddr::from([127, 0, 0, 1]));
        let ip = if is_trusted(&peer) {
            headers
                .get_all("x-forwarded-for")
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .map(|part| part.trim().parse::<IpAddr>().ok())
                .rev()
                // An address that cannot be read ends the search: whatever comes before it is no
                // better known.
                .map_while(|ip| ip)
                .find(|ip| !is_trusted(ip))
                .unwrap_or(peer)
        } else {
            peer
        };
        Self { ip, user_agent }
    }

    fn from_parts(parts: &Parts, trusted: &[IpNet]) -> Self {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        Self::from_request(&parts.headers, peer, trusted)
    }
}

impl FromRequestParts<App> for Client {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        Ok(Self::from_parts(parts, &app.config.trusted_proxies))
    }
}

/// A signed-in request: the sign-in, and its user.
#[derive(Debug, Clone)]
pub(crate) struct Signed {
    pub(crate) session: SessionRow,
    pub(crate) user: UserRow,
}

impl Signed {
    /// Whether the person confirmed who they are within `window`.
    pub(crate) fn is_fresh(&self, window: Duration) -> bool {
        self.session.verified_at.is_some_and(|at| {
            Utc::now()
                .signed_duration_since(at)
                .to_std()
                .is_ok_and(|age| age <= window)
        })
    }

    /// Refuses unless the person confirmed who they are within `window`.
    pub(crate) fn require_fresh(&self, window: Duration) -> Result<(), ApiError> {
        if self.is_fresh(window) {
            Ok(())
        } else {
            Err(ApiError::verification_required())
        }
    }
}

impl FromRequestParts<App> for Signed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        if let Some(signed) = parts.extensions.get::<Self>() {
            return Ok(signed.clone());
        }
        let client = Client::from_parts(parts, &app.config.trusted_proxies);
        let signed = app
            .auth
            .signed(&parts.headers, &client)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
        parts.extensions.insert(signed.clone());
        Ok(signed)
    }
}

/// Why a sign-in failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SignInError {
    #[error("the username or password is wrong")]
    Wrong,
    #[error("too many attempts")]
    Limited(Duration),
    #[error(transparent)]
    Passkey(#[from] passkeys::PasskeyError),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

/// Signing in, and the sign-ins there are.
pub(crate) struct Auth {
    store: Store,
    hasher: Hasher,
    pub(crate) passkeys: Passkeys,
    limits: Limits,
    https: bool,
    /// Counts the times sign-ins ended here, so connections held open look whether theirs did.
    ends: watch::Sender<u64>,
    /// Whether mekaweb is stopping, which ends every connection held open.
    stopping: std::sync::atomic::AtomicBool,
}

/// The rate limits on signing in and confirming.
struct Limits {
    addresses: Limiter,
    account: Limiter,
    challenges: Limiter,
    confirms: Limiter,
}

impl Auth {
    /// Signing in for `config`, with sign-ins kept in `store`.
    pub(crate) fn new(config: &Config, store: Store) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            hasher: Hasher::new()?,
            passkeys: Passkeys::for_site(&config.public_origin)?,
            limits: Limits {
                addresses: Limiter::new(SIGN_IN_PER_ADDRESS),
                account: Limiter::new(SIGN_IN_PER_ACCOUNT),
                challenges: Limiter::new(CHALLENGES_PER_ADDRESS),
                confirms: Limiter::new(CONFIRMS_PER_DEVICE),
            },
            https: config.is_https(),
            ends: watch::channel(0).0,
            stopping: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Ends every connection held open, as mekaweb stops: they would otherwise hold it up.
    pub(crate) fn stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Release);
        self.sessions_ended();
    }

    /// The password hasher.
    pub(crate) fn hasher(&self) -> &Hasher {
        &self.hasher
    }

    /// Spends a password guess for `client`'s network and the account.
    fn limit_password(&self, client: &Client) -> Result<(), SignInError> {
        self.limits
            .addresses
            .take(&network(client.ip))
            .and_then(|()| self.limits.account.take("account"))
            .map_err(SignInError::Limited)
    }

    /// Spends a passkey sign-in for `client`'s network. A passkey cannot be guessed, so this
    /// bounds only the work, and leaves the account's ceiling to passwords.
    fn limit_passkey(&self, client: &Client) -> Result<(), SignInError> {
        self.limits
            .addresses
            .take(&network(client.ip))
            .map_err(SignInError::Limited)
    }

    /// Spends a passkey sign-in challenge for `client`'s network.
    pub(crate) fn limit_challenge(&self, client: &Client) -> Result<(), SignInError> {
        self.limits
            .challenges
            .take(&network(client.ip))
            .map_err(SignInError::Limited)
    }

    /// Spends a confirmation attempt for the signed-in device `session`. Kept apart from signing
    /// in, so a crowd guessing passwords cannot stop the account's holder from confirming.
    pub(crate) fn limit_confirm(&self, session: &str) -> Result<(), SignInError> {
        self.limits
            .confirms
            .take(session)
            .map_err(SignInError::Limited)
    }

    /// Signs in as `username` with `password`; the sign-in and its token.
    pub(crate) async fn sign_in_with_password(
        &self,
        username: &str,
        password: &str,
        client: &Client,
    ) -> Result<(SessionRow, String), SignInError> {
        // A refused attempt is not logged: a flood would write over the log.
        self.limit_password(client)?;
        let user = self
            .store
            .user()
            .await?
            .filter(|user| user.username == username);
        let right = self
            .hasher
            .verify(
                password,
                user.as_ref().map(|user| user.password_hash.as_str()),
            )
            .await?;
        match user.filter(|_| right) {
            Some(user) => {
                self.log(username, client, "password", "signed-in").await;
                Ok(self.start_session(&user, client, "password").await?)
            }
            None => {
                self.log(username, client, "password", "wrong").await;
                Err(SignInError::Wrong)
            }
        }
    }

    /// Signs in with the passkey `credential`, answering the challenge `challenge`.
    pub(crate) async fn sign_in_with_passkey(
        &self,
        challenge: &str,
        credential: &serde_json::Value,
        client: &Client,
    ) -> Result<(SessionRow, String), SignInError> {
        self.limit_passkey(client)?;
        match self
            .passkeys
            .finish_sign_in(&self.store, challenge, credential)
            .await
        {
            Ok(user) => {
                self.log(&user.username, client, "passkey", "signed-in")
                    .await;
                Ok(self.start_session(&user, client, "passkey").await?)
            }
            Err(error) => {
                self.log("", client, "passkey", "refused").await;
                Err(error.into())
            }
        }
    }

    async fn start_session(
        &self,
        user: &UserRow,
        client: &Client,
        method: &str,
    ) -> anyhow::Result<(SessionRow, String)> {
        let token = random_token()?;
        let session = self
            .store
            .add_session(
                &sha256_hex(token.as_bytes()),
                user.id,
                &client.user_agent,
                method,
                &client.ip.to_string(),
            )
            .await?;
        Ok((session, token))
    }

    /// Writes a sign-in attempt to the log; a failure to is logged, not raised.
    pub(crate) async fn log(&self, username: &str, client: &Client, method: &str, outcome: &str) {
        let entry = LogEntry {
            at: Utc::now(),
            username: username.chars().take(128).collect(),
            ip: client.ip.to_string(),
            user_agent: client.user_agent.clone(),
            method: method.to_owned(),
            outcome: outcome.to_owned(),
        };
        if let Err(error) = self.store.log(entry).await {
            tracing::error!("could not log a sign-in attempt: {error:#}");
        }
    }

    /// The sign-in a request's cookie holds, if it is still good; noting its use.
    pub(crate) async fn signed(
        &self,
        headers: &HeaderMap,
        client: &Client,
    ) -> anyhow::Result<Option<Signed>> {
        let Some(token) = read_cookie(headers, &self.cookie_name()) else {
            return Ok(None);
        };
        let Some(session) = self
            .store
            .session_by_token(&sha256_hex(token.as_bytes()))
            .await?
        else {
            return Ok(None);
        };
        let now = Utc::now();
        if is_expired(&session, now) {
            self.store
                .delete_session(session.user_id, &session.id)
                .await?;
            self.sessions_ended();
            return Ok(None);
        }
        let Some(user) = self.store.user_by_id(session.user_id).await? else {
            return Ok(None);
        };
        let ip = client.ip.to_string();
        if is_older(session.last_seen_at, now, TOUCH_EVERY) || session.last_ip != ip {
            self.store.touch_session(&session.id, &ip).await?;
        }
        Ok(Some(Signed { session, user }))
    }

    /// Tells the connections held open that sign-ins have ended, so each looks whether its own
    /// has. Whatever ends a sign-in in this process calls it; one ended from the command line is
    /// found within [`RECHECK_EVERY`].
    pub(crate) fn sessions_ended(&self) {
        self.ends
            .send_modify(|count| *count = count.wrapping_add(1));
    }

    /// Waits until the sign-in `id` has ended: signed out, here or from the command line, or
    /// expired, or until mekaweb stops. A connection held open, an event stream or a terminal,
    /// ends with it.
    pub(crate) async fn until_ended(&self, id: &str) {
        let mut ends = self.ends.subscribe();
        loop {
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            tokio::select! {
                changed = ends.changed() => {
                    if changed.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
                () = tokio::time::sleep(RECHECK_EVERY) => {}
            }
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            match self.store.session_by_id(id).await {
                Ok(Some(session)) if !is_expired(&session, Utc::now()) => {}
                Ok(_) => return,
                Err(error) => tracing::warn!("could not look whether a sign-in ended: {error:#}"),
            }
        }
    }

    /// The sign-in cookie's name: `__Host-` prefixed where cookies are secure, so another host
    /// under the same domain cannot plant one.
    pub(crate) fn cookie_name(&self) -> String {
        if self.https {
            format!("__Host-{SESSION_COOKIE}")
        } else {
            SESSION_COOKIE.to_owned()
        }
    }

    /// The `Set-Cookie` value that holds `token`.
    pub(crate) fn session_cookie(&self, token: &str) -> String {
        format!(
            "{}={token}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict{}",
            self.cookie_name(),
            ABSOLUTE_LIFETIME.as_secs(),
            if self.https { "; Secure" } else { "" }
        )
    }

    /// The `Set-Cookie` value that removes the sign-in cookie.
    pub(crate) fn clear_cookie(&self) -> String {
        format!(
            "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{}",
            self.cookie_name(),
            if self.https { "; Secure" } else { "" }
        )
    }
}

/// Whether `session` has gone unused too long, or lasted as long as any may.
fn is_expired(session: &SessionRow, now: DateTime<Utc>) -> bool {
    is_older(session.last_seen_at, now, IDLE_LIFETIME)
        || is_older(session.created_at, now, ABSOLUTE_LIFETIME)
}

/// Whether `at` is more than `age` before `now`.
fn is_older(at: DateTime<Utc>, now: DateTime<Utc>, age: Duration) -> bool {
    now.signed_duration_since(at)
        .to_std()
        .is_ok_and(|elapsed| elapsed > age)
}

/// A random token: 32 bytes in URL-safe base64.
pub(crate) fn random_token() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no randomness: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// SHA-256 of `bytes`, in hex.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The value of cookie `name` in a request's `Cookie` headers.
pub(crate) fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
        .filter(|value| !value.is_empty())
}

/// The digits, dots and underscores just after `marker` in `text`, if there are any.
fn version_after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let rest = &text[text.find(marker)? + marker.len()..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '_'))
        .unwrap_or(rest.len());
    Some(&rest[..end]).filter(|version| !version.is_empty())
}

/// What a browser's user agent says of the device, with the versions it gives, such as
/// "Safari 18 on iOS 18.0" or "Chrome 130 on Linux". Windows and macOS report no version a person
/// would know, so they have none.
pub(crate) fn device_details(user_agent: &str) -> String {
    // Each browser, and where its version follows.
    let browser = [
        ("Edg/", "Edge", "Edg/"),
        ("OPR/", "Opera", "OPR/"),
        ("Firefox/", "Firefox", "Firefox/"),
        ("FxiOS/", "Firefox", "FxiOS/"),
        ("CriOS/", "Chrome", "CriOS/"),
        ("Chromium/", "Chromium", "Chromium/"),
        ("Chrome/", "Chrome", "Chrome/"),
        ("Safari/", "Safari", "Version/"),
    ]
    .into_iter()
    .find(|(needle, ..)| user_agent.contains(needle))
    .map(|(_, name, marker)| {
        match version_after(user_agent, marker).and_then(|version| version.split(['.', '_']).next())
        {
            Some(major) => format!("{name} {major}"),
            None => name.to_owned(),
        }
    });
    let versioned = |name: &str, marker: &str| match version_after(user_agent, marker) {
        Some(version) => format!("{name} {}", version.replace('_', ".")),
        None => name.to_owned(),
    };
    let platform = if user_agent.contains("iPhone") {
        Some(versioned("iOS", "iPhone OS "))
    } else if user_agent.contains("iPad") {
        Some(versioned("iPadOS", "CPU OS "))
    } else if user_agent.contains("Android") {
        Some(versioned("Android", "Android "))
    } else if user_agent.contains("CrOS") {
        Some("ChromeOS".to_owned())
    } else if user_agent.contains("Windows") {
        Some("Windows".to_owned())
    } else if user_agent.contains("Macintosh") || user_agent.contains("Mac OS X") {
        Some("macOS".to_owned())
    } else if user_agent.contains("Linux") {
        Some("Linux".to_owned())
    } else {
        None
    };
    match (browser, platform) {
        (Some(browser), Some(platform)) => format!("{browser} on {platform}"),
        (Some(browser), None) => browser,
        (None, Some(platform)) => platform,
        (None, None) => "Unknown device".to_owned(),
    }
}

/// A name for the device a browser's user agent describes, such as "Safari on iPhone".
pub(crate) fn device_name(user_agent: &str) -> String {
    let platform = [
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Android", "Android"),
        ("CrOS", "ChromeOS"),
        ("Windows", "Windows"),
        ("Macintosh", "Mac"),
        ("Mac OS X", "Mac"),
        ("Linux", "Linux"),
    ]
    .into_iter()
    .find(|(needle, _)| user_agent.contains(needle))
    .map(|(_, name)| name);
    let browser = [
        ("Edg/", "Edge"),
        ("OPR/", "Opera"),
        ("Firefox/", "Firefox"),
        ("FxiOS/", "Firefox"),
        ("CriOS/", "Chrome"),
        ("Chromium/", "Chromium"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ]
    .into_iter()
    .find(|(needle, _)| user_agent.contains(needle))
    .map(|(_, name)| name);
    match (browser, platform) {
        (Some(browser), Some(platform)) => format!("{browser} on {platform}"),
        (Some(browser), None) => browser.to_owned(),
        (None, Some(platform)) => platform.to_owned(),
        (None, None) => "Unknown device".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn cookies_are_read_from_any_header() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; mekaweb_session=abc"),
        );
        headers.append(header::COOKIE, HeaderValue::from_static("b=2"));
        assert_eq!(read_cookie(&headers, SESSION_COOKIE), Some("abc"));
        assert_eq!(read_cookie(&headers, "b"), Some("2"));
        assert_eq!(read_cookie(&headers, "c"), None);
    }

    #[test]
    fn address_headers_are_believed_only_from_a_trusted_proxy() {
        let trusted: Vec<IpNet> = vec!["127.0.0.1/32".parse().unwrap()];
        let mut headers = HeaderMap::new();
        // What a client claims comes first; each proxy appends who reached it.
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.66, 198.51.100.1, 127.0.0.1"),
        );
        headers.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.7"));
        let local = Some(IpAddr::from([127, 0, 0, 1]));
        let stranger = IpAddr::from([192, 0, 2, 9]);
        assert_eq!(
            Client::from_request(&headers, local, &trusted).ip,
            "198.51.100.1".parse::<IpAddr>().unwrap(),
            "the last address that is not a trusted proxy; CF-Connecting-IP is not read"
        );
        assert_eq!(
            Client::from_request(&headers, Some(stranger), &trusted).ip,
            stranger
        );
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.1, unknown"),
        );
        assert_eq!(
            Client::from_request(&headers, local, &trusted).ip,
            IpAddr::from([127, 0, 0, 1]),
            "nothing before an address that cannot be read is believed"
        );
    }

    #[test]
    fn devices_are_named_by_browser_and_platform() {
        assert_eq!(
            device_name(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
            ),
            "Safari on iPhone"
        );
        assert_eq!(
            device_name(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
            ),
            "Chrome on Linux"
        );
        assert_eq!(
            device_name(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"
            ),
            "Firefox on Windows"
        );
        assert_eq!(device_name("curl/8.0"), "Unknown device");
    }

    #[test]
    fn devices_are_described_with_their_versions() {
        assert_eq!(
            device_details(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
            ),
            "Safari 18 on iOS 18.0"
        );
        assert_eq!(
            device_details(
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
            ),
            "Chrome 140 on Android 15"
        );
        assert_eq!(
            device_details(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"
            ),
            "Safari 18 on macOS"
        );
        assert_eq!(
            device_details(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
            ),
            "Chrome 155 on Linux"
        );
        assert_eq!(
            device_details(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"
            ),
            "Edge 140 on Windows"
        );
        assert_eq!(device_details("curl/8.0"), "Unknown device");
    }

    #[test]
    fn tokens_are_long_and_hashes_are_hex() {
        assert_eq!(random_token().unwrap().len(), 43);
        assert_eq!(sha256_hex(b"abc").len(), 64);
    }
}
