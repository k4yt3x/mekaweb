//! Push notifications: when a turn finishes or fails, or waits for an approval, every device
//! subscribed hears of it through its browser's push service, even with the app closed. That is
//! the only way a suspended iPhone app hears anything.
//!
//! mekaweb follows meka's server feed, `/v1/stream`, which carries every session's turn
//! lifecycle and approval prompts, and keeps each session's title and parent from the records it
//! also carries. A device watching a session (its event stream open through mekaweb) is not
//! notified of that session. Sub-agents' turns and compactions notify nobody.
//!
//! Every push shows a notification: iOS cancels a subscription whose pushes show nothing.
//!
//! The feed is followed with push notifications off too: a session it says was deleted takes its
//! terminals with it.

pub(crate) mod crypto;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use p256::SecretKey;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    config::Config,
    meka::Meka,
    proxy::Watching,
    store::{Store, SubscriptionRow},
    terminal::Terminals,
};

/// The secret mekaweb's VAPID key is kept under.
const KEY_SECRET: &str = "vapid_private_key";

/// How long a push may take.
const SEND_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the push service keeps a finished or failed turn's notification for a device that is
/// offline.
const OUTCOME_TTL: u32 = 4 * 60 * 60;

/// How long it keeps an approval's: as long as meka waits for an answer.
const APPROVAL_TTL: u32 = 30 * 60;

/// The longest wait between attempts to follow meka's feed.
const MAX_RETRY: Duration = Duration::from_secs(30);

/// The longest event of meka's feed read; a longer one is left out.
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

/// How long after first following meka's feed what arrives is taken for its backlog: events from
/// before mekaweb started, which were notified of then or are stale now.
const BACKLOG_WINDOW: Duration = Duration::from_secs(2);

/// The longest session title a notification carries.
const MAX_TITLE_CHARS: usize = 200;

/// The most of a push service's refusal that is read, to report.
const MAX_REFUSAL_BYTES: usize = 1024;

/// The push services a subscription's endpoint may be at: Google's (Chrome and most other
/// browsers), Mozilla's, Apple's and Microsoft's. Nothing else is posted to.
const PUSH_SERVICES: &[&str] = &[
    "googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
];

/// Whether `endpoint` is at one of the [`PUSH_SERVICES`], over HTTPS.
pub(crate) fn is_push_service(endpoint: &url::Url) -> bool {
    let Some(url::Host::Domain(host)) = endpoint.host() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    endpoint.scheme() == "https"
        && endpoint.port().is_none()
        && PUSH_SERVICES.iter().any(|service| {
            host == *service
                || host
                    .strip_suffix(service)
                    .is_some_and(|rest| rest.ends_with('.'))
        })
}

/// What a push says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PushKind {
    Finished,
    Failed,
    Approval,
    Test,
}

/// A push's message, which the service worker shows.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Message {
    pub(crate) kind: PushKind,
    /// The meka session it is about.
    pub(crate) session: Option<String>,
    /// The session's title.
    pub(crate) title: String,
    /// How many approvals are waiting, for the app icon's badge.
    pub(crate) badge: Option<u64>,
}

/// Why a push could not be sent.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PushError {
    #[error("push notifications are turned off: set push.subject in mekaweb's config")]
    Disabled,
    #[error("this device has not turned on push notifications")]
    NotSubscribed,
    #[error("the push service no longer knows this device; turn push notifications on again")]
    Gone,
    #[error("the push service refused the notification: {0}")]
    Refused(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

/// What mekaweb knows of a session.
#[derive(Debug, Clone)]
struct SessionInfo {
    title: String,
    parent: Option<String>,
}

/// Push notifications.
pub(crate) struct Push {
    key: SecretKey,
    public: String,
    subject: Option<String>,
    store: Store,
    meka: Arc<Meka>,
    watching: Arc<Watching>,
    terminals: Arc<Terminals>,
    client: reqwest::Client,
    sessions: Mutex<HashMap<String, SessionInfo>>,
    compactions: Mutex<HashSet<String>>,
}

impl Push {
    /// Push notifications for `config`, with mekaweb's key made on first start and kept in
    /// `store`.
    pub(crate) async fn open(
        config: &Config,
        store: Store,
        meka: Arc<Meka>,
        watching: Arc<Watching>,
        terminals: Arc<Terminals>,
    ) -> anyhow::Result<Arc<Self>> {
        let candidate = URL_SAFE_NO_PAD.encode(crypto::random_key()?.to_bytes());
        let kept = store.keep_secret(KEY_SECRET, &candidate).await?;
        let key = SecretKey::from_slice(&URL_SAFE_NO_PAD.decode(kept)?)
            .map_err(|_| anyhow::anyhow!("the kept VAPID key is not a P-256 key"))?;
        let public = URL_SAFE_NO_PAD.encode(crypto::public_bytes(&key));
        let client = reqwest::Client::builder()
            .timeout(SEND_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Arc::new(Self {
            key,
            public,
            subject: config.push_subject.clone(),
            store,
            meka,
            watching,
            terminals,
            client,
            sessions: Mutex::new(HashMap::new()),
            compactions: Mutex::new(HashSet::new()),
        }))
    }

    /// Whether pushes can be sent.
    pub(crate) fn is_enabled(&self) -> bool {
        self.subject.is_some()
    }

    /// The public key browsers subscribe with, uncompressed, in URL-safe base64.
    pub(crate) fn public_key(&self) -> &str {
        &self.public
    }

    /// Sends `message` to the subscription `subscription`, removing it if the push service says
    /// it is gone.
    pub(crate) async fn send(
        &self,
        subscription: &SubscriptionRow,
        message: &Message,
    ) -> Result<(), PushError> {
        let subject = self.subject.as_deref().ok_or(PushError::Disabled)?;
        let endpoint = url::Url::parse(&subscription.endpoint).map_err(anyhow::Error::from)?;
        if !is_push_service(&endpoint) {
            self.store.delete_subscription(&subscription.id).await?;
            return Err(PushError::Gone);
        }
        let mut message = message.clone();
        if message.title.chars().count() > MAX_TITLE_CHARS {
            message.title = message.title.chars().take(MAX_TITLE_CHARS - 1).collect();
            message.title.push('…');
        }
        let message = &message;
        let receiver = crypto::Receiver::from_base64(&subscription.p256dh, &subscription.auth)?;
        let body = crypto::encrypt(
            &serde_json::to_vec(message).map_err(anyhow::Error::from)?,
            &receiver,
        )?;
        let authorization = crypto::vapid(
            &endpoint,
            &self.key,
            subject,
            chrono::Utc::now().timestamp(),
        )?;
        let (urgency, ttl) = match message.kind {
            PushKind::Approval => ("high", APPROVAL_TTL),
            _ => ("normal", OUTCOME_TTL),
        };
        let mut request = self
            .client
            .post(endpoint)
            .header("Authorization", authorization)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", ttl.to_string())
            .header("Urgency", urgency)
            .body(body);
        // An undelivered notification of a session is replaced by a newer one.
        if let Some(session) = &message.session {
            request = request.header("Topic", topic(session));
        }
        let response = request.send().await.map_err(anyhow::Error::from)?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
            self.store.delete_subscription(&subscription.id).await?;
            return Err(PushError::Gone);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(Ok(chunk)) = stream.next().await {
            body.extend_from_slice(&chunk);
            if body.len() >= MAX_REFUSAL_BYTES {
                break;
            }
        }
        let text = String::from_utf8_lossy(
            body.get(..MAX_REFUSAL_BYTES.min(body.len()))
                .unwrap_or_default(),
        );
        Err(PushError::Refused(format!(
            "{status} {}",
            text.chars().take(300).collect::<String>()
        )))
    }

    /// Sends `message` about `session` to every device not watching it.
    async fn notify(&self, session: &str, message: Message) {
        let subscriptions = match self.store.subscriptions().await {
            Ok(subscriptions) => subscriptions,
            Err(error) => {
                tracing::error!("could not read the push subscriptions: {error:#}");
                return;
            }
        };
        for subscription in subscriptions {
            if self.watching.is_watching(&subscription.session_id, session) {
                continue;
            }
            match self.send(&subscription, &message).await {
                Ok(()) | Err(PushError::Gone) => {}
                Err(error) => tracing::warn!("a push notification was not sent: {error}"),
            }
        }
    }

    /// Follows meka's server feed for as long as mekaweb runs, notifying as it goes.
    pub(crate) async fn follow(self: Arc<Self>) {
        let mut cursor: Option<String> = None;
        let mut retry = Duration::from_secs(1);
        loop {
            match self.follow_once(&mut cursor).await {
                Ok(()) => retry = Duration::from_secs(1),
                Err(error) => {
                    // Said once, not every attempt, while meka stays away.
                    if retry == Duration::from_secs(1) {
                        tracing::warn!(
                            "following meka's feed for push notifications stopped: {error:#}"
                        );
                    }
                    retry = (retry * 2).min(MAX_RETRY);
                }
            }
            tokio::time::sleep(retry).await;
        }
    }

    async fn follow_once(&self, cursor: &mut Option<String>) -> anyhow::Result<()> {
        let mut request = self
            .meka
            .client()
            .get(self.meka.url("/v1/stream")?)
            .bearer_auth(self.meka.token())
            .header("Accept", "text/event-stream");
        if let Some(cursor) = cursor.as_deref() {
            request = request.header("Last-Event-ID", cursor);
        }
        // Joining with no position, meka hands over what its feed still holds first: that is
        // history, not news.
        let backlog_until = cursor
            .is_none()
            .then(|| tokio::time::Instant::now() + BACKLOG_WINDOW);
        let response = request.send().await?.error_for_status()?;
        let mut stream = response.bytes_stream();
        let mut parser = Frames::default();
        while let Some(chunk) = stream.next().await {
            for frame in parser.push(&chunk?) {
                if let Some(id) = &frame.id {
                    *cursor = Some(id.clone());
                }
                let news = backlog_until.is_none_or(|until| tokio::time::Instant::now() >= until);
                self.event(&frame, news).await;
            }
        }
        Ok(())
    }

    /// Takes in `frame`, notifying of it if it is `news`.
    async fn event(&self, frame: &Frame, news: bool) {
        // With push notifications off, the feed is followed for what it says of sessions alone.
        let news = news && self.is_enabled();
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&frame.data) else {
            return;
        };
        let text = |key: &str| {
            data.get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        match frame.event.as_str() {
            "session.created" | "session.updated" => {
                if let (Some(id), Some(title)) = (text("id"), text("title")) {
                    self.remember(id, title, text("parent_id"));
                }
            }
            "session.deleted" => {
                if let Some(id) = text("id") {
                    self.sessions_map().remove(&id);
                    self.terminals.close_session(&id).await;
                }
            }
            "turn.started" => {
                if text("source").as_deref() == Some("compaction")
                    && let Some(turn) = text("turn_id")
                {
                    self.compactions_set().insert(turn);
                }
            }
            "turn.finished" | "turn.failed" => {
                let (Some(session), Some(turn)) = (text("session_id"), text("turn_id")) else {
                    return;
                };
                if self.compactions_set().remove(&turn) || !news {
                    return;
                }
                let Some(info) = self.session(&session).await else {
                    return;
                };
                if info.parent.is_some() {
                    return;
                }
                let kind = if frame.event == "turn.finished" {
                    PushKind::Finished
                } else {
                    PushKind::Failed
                };
                let message = Message {
                    kind,
                    session: Some(session.clone()),
                    title: info.title,
                    badge: self.waiting_approvals().await,
                };
                self.notify(&session, message).await;
            }
            "permission_required" => {
                let Some(session) = text("session_id").filter(|_| news) else {
                    return;
                };
                let title = self
                    .session(&session)
                    .await
                    .map(|info| info.title)
                    .unwrap_or_default();
                let message = Message {
                    kind: PushKind::Approval,
                    session: Some(session.clone()),
                    title,
                    badge: self.waiting_approvals().await,
                };
                self.notify(&session, message).await;
            }
            _ => {}
        }
    }

    fn sessions_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionInfo>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn compactions_set(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.compactions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remember(&self, id: String, title: String, parent: Option<String>) {
        self.sessions_map()
            .insert(id, SessionInfo { title, parent });
    }

    /// What mekaweb knows of `session`, asking meka if it does not.
    async fn session(&self, session: &str) -> Option<SessionInfo> {
        if let Some(info) = self.sessions_map().get(session).cloned() {
            return Some(info);
        }
        let path = format!("/v1/sessions/{session}");
        let response = self
            .meka
            .client()
            .get(self.meka.url(&path).ok()?)
            .bearer_auth(self.meka.token())
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let record: serde_json::Value = response.json().await.ok()?;
        let title = record.get("title")?.as_str()?.to_owned();
        let parent = record
            .get("parent_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        self.remember(session.to_owned(), title.clone(), parent.clone());
        Some(SessionInfo { title, parent })
    }

    /// How many approvals wait across meka's sessions, for the badge.
    async fn waiting_approvals(&self) -> Option<u64> {
        let mut url = self.meka.url("/v1/sessions").ok()?;
        url.query_pairs_mut().append_pair("limit", "200");
        let response = self
            .meka
            .client()
            .get(url)
            .bearer_auth(self.meka.token())
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let list: serde_json::Value = response.json().await.ok()?;
        Some(
            list.get("sessions")?
                .as_array()?
                .iter()
                .filter_map(|session| session.get("approvals_pending")?.as_u64())
                .sum(),
        )
    }
}

/// A push's `Topic`: at most 32 characters of URL-safe base64, the same for a session's pushes.
fn topic(session: &str) -> String {
    let digest = Sha256::digest(session.as_bytes());
    URL_SAFE_NO_PAD.encode(digest).chars().take(32).collect()
}

/// An event of meka's feed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Frame {
    id: Option<String>,
    event: String,
    data: String,
}

/// Splits an event stream into its frames as it arrives.
#[derive(Debug, Default)]
struct Frames {
    partial: Vec<u8>,
    current: Frame,
    has_data: bool,
    /// Whether the frame under way grew too long, and is left out.
    skipping: bool,
}

impl Frames {
    fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        // Only the new piece can hold a line's end.
        let mut from = self.partial.len();
        self.partial.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        while let Some(offset) = self
            .partial
            .get(from..)
            .and_then(|rest| rest.iter().position(|byte| *byte == b'\n'))
        {
            let end = from + offset;
            let mut line = self.partial.get(start..end).unwrap_or_default();
            start = end + 1;
            from = start;
            if line.last() == Some(&b'\r') {
                line = line.get(..line.len() - 1).unwrap_or_default();
            }
            let line = String::from_utf8_lossy(line).into_owned();
            if self.skipping {
                if line.is_empty() {
                    self.skipping = false;
                    self.current = Frame::default();
                    self.has_data = false;
                }
                continue;
            }
            if line.is_empty() {
                if self.has_data || !self.current.event.is_empty() {
                    frames.push(std::mem::take(&mut self.current));
                }
                self.has_data = false;
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((&line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "id" => self.current.id = Some(value.to_owned()),
                "event" => self.current.event = value.to_owned(),
                "data" => {
                    if self.has_data {
                        self.current.data.push('\n');
                    }
                    self.current.data.push_str(value);
                    self.has_data = true;
                }
                _ => {}
            }
        }
        self.partial.drain(..start);
        if self.current.data.len() + self.partial.len() > MAX_FRAME_BYTES {
            tracing::warn!("an event of meka's feed was too long to read, and is left out");
            self.partial.clear();
            self.current = Frame::default();
            self.has_data = false;
            self.skipping = true;
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_however_the_stream_is_cut() {
        let input = ": heartbeat\n\nid: 3\nevent: turn.finished\ndata: {\"a\":\n data: 1}\n\nevent: x\ndata: y\n\n";
        for size in [1, 3, 100] {
            let mut parser = Frames::default();
            let mut frames = Vec::new();
            for chunk in input.as_bytes().chunks(size) {
                frames.extend(parser.push(chunk));
            }
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0].id.as_deref(), Some("3"));
            assert_eq!(frames[0].event, "turn.finished");
            assert_eq!(frames[1].data, "y");
        }
    }

    #[test]
    fn a_frame_too_long_is_left_out_and_the_next_read() {
        let mut frames = Frames::default();
        let long = "x".repeat(MAX_FRAME_BYTES / 4);
        let mut read = Vec::new();
        read.extend(frames.push(b"event: big\ndata: "));
        for _ in 0..5 {
            read.extend(frames.push(long.as_bytes()));
        }
        read.extend(frames.push(b"\n\nevent: small\ndata: 1\n\n"));
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].event, "small");
        assert!(frames.partial.is_empty());
    }

    #[test]
    fn only_known_push_services_are_posted_to() {
        let at = |endpoint: &str| is_push_service(&url::Url::parse(endpoint).unwrap());
        assert!(at("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(at("https://web.push.apple.com/QGh"));
        assert!(at("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(at("https://wns2-by3p.notify.windows.com/w/?token=x"));
        assert!(!at("http://fcm.googleapis.com/fcm/send/abc"), "HTTPS only");
        assert!(!at("https://evilgoogleapis.com/x"));
        assert!(!at("https://googleapis.com.evil.example/x"));
        assert!(!at("https://fcm.googleapis.com:8443/x"));
        assert!(!at("https://127.0.0.1/x"));
        assert!(!at("https://localhost/x"));
    }

    #[test]
    fn a_topic_is_short_and_stable() {
        let topic = topic("7f3a1c22-0000-4000-8000-000000000000");
        assert_eq!(topic.len(), 32);
        assert!(
            topic
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }
}
