//! Passkeys (WebAuthn): to sign in with, and to confirm who you are before something risky. The
//! relying party is the host of `public_origin`; a browser offers passkeys only to a site reached
//! by name, over HTTPS or on `localhost`, so a mekaweb reached at an IP address or over plain HTTP
//! elsewhere has none, and signs in with its password alone.
//!
//! Each ceremony is a challenge kept in memory for a few minutes, under an id the browser sends
//! back with its answer, and used once. Anyone may ask for a sign-in challenge, so those are kept
//! apart from a signed-in device's, and a full pool makes way for a new one by dropping its oldest:
//! a flood of requests can slow passkey sign-in, never stop confirming on a signed-in device.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use webauthn_rs::prelude::{
    AuthenticationResult, DiscoverableAuthentication, DiscoverableKey, Passkey,
    PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential,
    Url, Webauthn, WebauthnBuilder,
};

use crate::store::{PasskeyRow, Store, UserRow};

/// How long a challenge waits for its answer.
const CHALLENGE_LIFETIME: Duration = Duration::from_secs(5 * 60);

/// The most sign-in challenges waiting at once, so a flood cannot fill memory.
const MAX_SIGN_IN_CHALLENGES: usize = 10_000;

/// The most challenges one signed-in device may have waiting.
const MAX_DEVICE_CHALLENGES: usize = 8;

/// The longest name a passkey may have.
pub(crate) const MAX_PASSKEY_NAME_CHARS: usize = 60;

/// What the relying party calls itself to the browser and the authenticator.
const RELYING_PARTY_NAME: &str = "mekaweb";

/// Why a passkey ceremony failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PasskeyError {
    #[error("passkeys need mekaweb to be reached by name over HTTPS, or on localhost")]
    Unavailable,
    #[error("that passkey request expired; try again")]
    Expired,
    #[error("the passkey was not accepted")]
    Refused,
    #[error("that passkey is added already")]
    Taken,
    #[error("there are no passkeys to check with")]
    NoPasskeys,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

/// What a challenge was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// Adding a passkey.
    Register,
    /// Signing in.
    SignIn,
    /// Confirming who you are.
    Confirm,
}

enum State {
    Register(PasskeyRegistration),
    Authenticate(PasskeyAuthentication),
    Discover(DiscoverableAuthentication),
}

struct Waiting {
    purpose: Purpose,
    /// The signed-in device the challenge was made for, if any.
    device: Option<String>,
    expires: Instant,
    state: State,
}

/// Challenges waiting, and the order they came in, oldest first.
#[derive(Default)]
struct Pool {
    waiting: HashMap<String, Waiting>,
    order: VecDeque<String>,
}

impl Pool {
    /// Adds `challenge` under `id`, dropping expired challenges, and the oldest while there are
    /// `max` or more; with a device, counting only that device's.
    fn add(&mut self, id: String, challenge: Waiting, max: usize, now: Instant) {
        while let Some(oldest) = self.order.front() {
            match self.waiting.get(oldest) {
                Some(waiting) if waiting.expires > now => break,
                _ => {
                    if let Some(oldest) = self.order.pop_front() {
                        self.waiting.remove(&oldest);
                    }
                }
            }
        }
        let device = challenge.device.clone();
        let mine = |waiting: &Waiting| waiting.device == device;
        let mut count = self
            .waiting
            .values()
            .filter(|waiting| mine(waiting))
            .count();
        let mut index = 0;
        while count >= max && index < self.order.len() {
            let is_mine = self
                .order
                .get(index)
                .and_then(|key| self.waiting.get(key))
                .is_some_and(mine);
            if is_mine {
                if let Some(key) = self.order.remove(index) {
                    self.waiting.remove(&key);
                }
                count -= 1;
            } else {
                index += 1;
            }
        }
        // Ids taken already linger in the order until they reach its front.
        self.order.retain(|key| self.waiting.contains_key(key));
        self.order.push_back(id.clone());
        self.waiting.insert(id, challenge);
    }

    fn take(&mut self, id: &str) -> Option<Waiting> {
        self.waiting.remove(id)
    }
}

/// A challenge for the browser to put to an authenticator, and the id its answer comes back with.
#[derive(Debug, Clone)]
pub(crate) struct Challenge {
    pub(crate) id: String,
    /// The options for `navigator.credentials.create()` or `get()`, as JSON with base64url bytes.
    pub(crate) options: serde_json::Value,
}

/// The relying party, where passkeys are possible, and the challenges waiting.
pub(crate) struct Passkeys {
    webauthn: Option<Webauthn>,
    /// Sign-in challenges, which anyone may ask for.
    signing_in: Mutex<Pool>,
    /// Challenges signed-in devices asked for.
    signed_in: Mutex<Pool>,
}

impl Passkeys {
    /// The relying party for a site at `origin`, or none where browsers offer no passkeys.
    pub(crate) fn for_site(origin: &Url) -> anyhow::Result<Self> {
        let webauthn = match origin.domain() {
            Some(host) if origin.scheme() == "https" || is_local(host) => Some(
                WebauthnBuilder::new(host, origin)
                    .and_then(|builder| builder.rp_name(RELYING_PARTY_NAME).build())
                    .map_err(|error| {
                        anyhow::anyhow!("could not set up passkeys for {origin}: {error}")
                    })?,
            ),
            _ => None,
        };
        Ok(Self {
            webauthn,
            signing_in: Mutex::new(Pool::default()),
            signed_in: Mutex::new(Pool::default()),
        })
    }

    /// Whether passkeys work here.
    pub(crate) fn is_available(&self) -> bool {
        self.webauthn.is_some()
    }

    fn webauthn(&self) -> Result<&Webauthn, PasskeyError> {
        self.webauthn.as_ref().ok_or(PasskeyError::Unavailable)
    }

    fn pool(&self, device: Option<&str>) -> std::sync::MutexGuard<'_, Pool> {
        match device {
            Some(_) => &self.signed_in,
            None => &self.signing_in,
        }
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Keeps a challenge's state for `purpose`, made for the signed-in `device` if any; its id.
    fn wait(
        &self,
        purpose: Purpose,
        device: Option<&str>,
        state: State,
    ) -> Result<String, PasskeyError> {
        let id = super::random_token()?;
        let now = Instant::now();
        let max = if device.is_some() {
            MAX_DEVICE_CHALLENGES
        } else {
            MAX_SIGN_IN_CHALLENGES
        };
        self.pool(device).add(
            id.clone(),
            Waiting {
                purpose,
                device: device.map(str::to_owned),
                expires: now + CHALLENGE_LIFETIME,
                state,
            },
            max,
            now,
        );
        Ok(id)
    }

    /// The state of the challenge `id`, if it was made for `purpose` and `device` and has not
    /// expired; used up either way.
    fn take(&self, id: &str, purpose: Purpose, device: Option<&str>) -> Option<State> {
        let challenge = self.pool(device).take(id)?;
        (challenge.expires > Instant::now()
            && challenge.purpose == purpose
            && challenge.device.as_deref() == device)
            .then_some(challenge.state)
    }

    /// A challenge that adds a discoverable passkey to `user`, not one they have already, on the
    /// signed-in `device`.
    pub(crate) async fn start_registration(
        &self,
        store: &Store,
        user: &UserRow,
        device: &str,
    ) -> Result<Challenge, PasskeyError> {
        let webauthn = self.webauthn()?;
        let exclude = store
            .passkeys(user.id)
            .await?
            .iter()
            .map(|row| row.passkey.cred_id().clone())
            .collect::<Vec<_>>();
        let (options, state) = webauthn
            .start_passkey_registration(
                user.handle,
                &user.username,
                &user.username,
                (!exclude.is_empty()).then_some(exclude),
            )
            .map_err(|error| anyhow::anyhow!("could not start adding a passkey: {error}"))?;
        let mut options = serde_json::to_value(options).map_err(anyhow::Error::from)?;
        // Discoverable, so it signs in without a username.
        if let Some(selection) = options
            .pointer_mut("/publicKey/authenticatorSelection")
            .and_then(serde_json::Value::as_object_mut)
        {
            selection.insert("residentKey".to_owned(), "required".into());
            selection.insert("requireResidentKey".to_owned(), true.into());
        }
        let id = self.wait(Purpose::Register, Some(device), State::Register(state))?;
        Ok(Challenge { id, options })
    }

    /// Adds the passkey `credential` made for the challenge `challenge` to `user`, named `name`.
    pub(crate) async fn finish_registration(
        &self,
        store: &Store,
        user: &UserRow,
        device: &str,
        name: &str,
        challenge: &str,
        credential: &serde_json::Value,
    ) -> Result<PasskeyRow, PasskeyError> {
        let webauthn = self.webauthn()?;
        let Some(State::Register(state)) = self.take(challenge, Purpose::Register, Some(device))
        else {
            return Err(PasskeyError::Expired);
        };
        let credential: RegisterPublicKeyCredential =
            serde_json::from_value(credential.clone()).map_err(|_| PasskeyError::Refused)?;
        let passkey = webauthn
            .finish_passkey_registration(&credential, &state)
            .map_err(|error| {
                tracing::info!(%error, "a new passkey was refused");
                PasskeyError::Refused
            })?;
        let credential_id = URL_SAFE_NO_PAD.encode(passkey.cred_id());
        if store.passkey_by_credential(&credential_id).await?.is_some() {
            return Err(PasskeyError::Taken);
        }
        let row = store
            .add_passkey(user.id, &passkey_name(name), &credential_id, &passkey)
            .await?;
        tracing::info!("a passkey was added");
        Ok(row)
    }

    /// A challenge any passkey of this site's answers, to sign in.
    pub(crate) fn start_sign_in(&self) -> Result<Challenge, PasskeyError> {
        let webauthn = self.webauthn()?;
        let (options, state) = webauthn
            .start_discoverable_authentication()
            .map_err(|error| anyhow::anyhow!("could not start a passkey sign-in: {error}"))?;
        let id = self.wait(Purpose::SignIn, None, State::Discover(state))?;
        Ok(Challenge {
            id,
            options: serde_json::to_value(options).map_err(anyhow::Error::from)?,
        })
    }

    /// The user whose passkey answered the sign-in challenge.
    pub(crate) async fn finish_sign_in(
        &self,
        store: &Store,
        challenge: &str,
        credential: &serde_json::Value,
    ) -> Result<UserRow, PasskeyError> {
        let webauthn = self.webauthn()?;
        let Some(State::Discover(state)) = self.take(challenge, Purpose::SignIn, None) else {
            return Err(PasskeyError::Expired);
        };
        let credential: PublicKeyCredential =
            serde_json::from_value(credential.clone()).map_err(|_| PasskeyError::Refused)?;
        let (handle, credential_id) = webauthn
            .identify_discoverable_authentication(&credential)
            .map_err(|_| PasskeyError::Refused)?;
        let row = store
            .passkey_by_credential(&URL_SAFE_NO_PAD.encode(credential_id))
            .await?
            .ok_or(PasskeyError::Refused)?;
        let user = store
            .user_by_id(row.user_id)
            .await?
            .filter(|user| user.handle == handle)
            .ok_or(PasskeyError::Refused)?;
        let keys: Vec<DiscoverableKey> = store
            .passkeys(user.id)
            .await?
            .iter()
            .map(|row| DiscoverableKey::from(&row.passkey))
            .collect();
        let result = webauthn
            .finish_discoverable_authentication(&credential, state, &keys)
            .map_err(|error| {
                tracing::info!(%error, "a passkey sign-in was refused");
                PasskeyError::Refused
            })?;
        record_use(store, row, &result).await?;
        Ok(user)
    }

    /// A challenge one of `user`'s passkeys answers, to confirm who they are on the signed-in
    /// `device`.
    pub(crate) async fn start_confirm(
        &self,
        store: &Store,
        user: &UserRow,
        device: &str,
    ) -> Result<Challenge, PasskeyError> {
        let webauthn = self.webauthn()?;
        let passkeys: Vec<Passkey> = store
            .passkeys(user.id)
            .await?
            .into_iter()
            .map(|row| row.passkey)
            .collect();
        if passkeys.is_empty() {
            return Err(PasskeyError::NoPasskeys);
        }
        let (options, state) = webauthn
            .start_passkey_authentication(&passkeys)
            .map_err(|error| anyhow::anyhow!("could not start a passkey check: {error}"))?;
        let id = self.wait(Purpose::Confirm, Some(device), State::Authenticate(state))?;
        Ok(Challenge {
            id,
            options: serde_json::to_value(options).map_err(anyhow::Error::from)?,
        })
    }

    /// Whether `credential` comes from one of `user`'s passkeys, answering the confirming
    /// challenge `challenge` made for `device`.
    pub(crate) async fn finish_confirm(
        &self,
        store: &Store,
        user: &UserRow,
        device: &str,
        challenge: &str,
        credential: &serde_json::Value,
    ) -> Result<(), PasskeyError> {
        let webauthn = self.webauthn()?;
        let Some(State::Authenticate(state)) = self.take(challenge, Purpose::Confirm, Some(device))
        else {
            return Err(PasskeyError::Expired);
        };
        let credential: PublicKeyCredential =
            serde_json::from_value(credential.clone()).map_err(|_| PasskeyError::Refused)?;
        let row = store
            .passkey_by_credential(&URL_SAFE_NO_PAD.encode(credential.get_credential_id()))
            .await?
            .filter(|row| row.user_id == user.id)
            .ok_or(PasskeyError::Refused)?;
        let result = webauthn
            .finish_passkey_authentication(&credential, &state)
            .map_err(|error| {
                tracing::info!(%error, "a passkey was refused");
                PasskeyError::Refused
            })?;
        record_use(store, row, &result).await?;
        Ok(())
    }
}

/// Whether `host` is a name browsers treat as secure without HTTPS.
fn is_local(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost")
}

/// Notes that the passkey `row` was used just now, keeping its new counter and backup state.
async fn record_use(
    store: &Store,
    mut row: PasskeyRow,
    result: &AuthenticationResult,
) -> anyhow::Result<()> {
    let changed = row.passkey.update_credential(result).unwrap_or(false);
    store
        .passkey_used(&row.id, changed.then_some(&row.passkey))
        .await
}

/// `name` tidied for a passkey, or a plain one when nothing is left.
pub(crate) fn passkey_name(name: &str) -> String {
    let name = tidy_name(name, MAX_PASSKEY_NAME_CHARS);
    if name.is_empty() {
        "Passkey".to_owned()
    } else {
        name
    }
}

/// `name` without control characters, its runs of white space made one space, at most `max`
/// characters long.
pub(crate) fn tidy_name(name: &str, max: usize) -> String {
    let visible: String = name
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    visible
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passkeys_are_offered_by_name_over_https_or_on_localhost() {
        let site = |origin: &str| {
            Passkeys::for_site(&Url::parse(origin).unwrap())
                .unwrap()
                .is_available()
        };
        assert!(site("https://meka.example.com"));
        assert!(site("http://localhost:4180"));
        assert!(!site("http://meka.example.com"));
        assert!(!site("https://192.168.1.2"));
    }

    fn waiting(device: Option<&str>, expires: Instant) -> Waiting {
        Waiting {
            purpose: Purpose::SignIn,
            device: device.map(str::to_owned),
            expires,
            state: State::Discover(
                WebauthnBuilder::new("localhost", &Url::parse("http://localhost").unwrap())
                    .unwrap()
                    .build()
                    .unwrap()
                    .start_discoverable_authentication()
                    .unwrap()
                    .1,
            ),
        }
    }

    #[test]
    fn a_full_pool_drops_its_oldest() {
        let now = Instant::now();
        let later = now + CHALLENGE_LIFETIME;
        let mut pool = Pool::default();
        for index in 0..3 {
            pool.add(index.to_string(), waiting(None, later), 3, now);
        }
        pool.add("3".to_owned(), waiting(None, later), 3, now);
        assert!(pool.take("0").is_none(), "the oldest made way");
        assert!(pool.take("3").is_some());
        assert_eq!(pool.waiting.len(), 2);
    }

    #[test]
    fn a_device_drops_only_its_own_challenges() {
        let now = Instant::now();
        let later = now + CHALLENGE_LIFETIME;
        let mut pool = Pool::default();
        pool.add("other".to_owned(), waiting(Some("b"), later), 2, now);
        for index in 0..3 {
            pool.add(index.to_string(), waiting(Some("a"), later), 2, now);
        }
        assert!(pool.take("other").is_some(), "another device's stays");
        assert!(pool.take("0").is_none());
        assert!(pool.take("1").is_some());
        assert!(pool.take("2").is_some());
    }

    #[test]
    fn expired_challenges_are_dropped() {
        let now = Instant::now();
        let mut pool = Pool::default();
        pool.add("old".to_owned(), waiting(None, now), 10, now);
        pool.add(
            "new".to_owned(),
            waiting(None, now + CHALLENGE_LIFETIME),
            10,
            now + Duration::from_secs(1),
        );
        assert!(pool.take("old").is_none());
        assert_eq!(pool.order.len(), 1);
    }

    #[test]
    fn a_passkey_name_is_tidied() {
        assert_eq!(passkey_name("  My   phone \u{7} "), "My phone");
        assert_eq!(passkey_name("   "), "Passkey");
        assert_eq!(
            passkey_name(&"x".repeat(100)).chars().count(),
            MAX_PASSKEY_NAME_CHARS
        );
    }
}
