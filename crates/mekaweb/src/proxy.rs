//! Passing the signed-in browser's requests to meka: `/meka/v1/…` becomes meka's `/v1/…`, with
//! meka's token added and the browser's own credentials taken off. Responses stream back as they
//! come, which event streams need; an event stream is compressed by hand, flushing after every
//! write, since a compressor that waits for a full buffer would hold events back.
//!
//! A session's event stream that passes through here marks that device as watching the session,
//! for as long as it is open, so push notifications skip what someone is looking at. A stream ends
//! when the device that opened it is signed out.
//!
//! The path goes to meka as the browser wrote it, still percent-encoded, so a name holding a `/`,
//! `?` or `%` reaches meka as one; a `.` or `..` segment is refused rather than resolved.
//! Responses are sandboxed: opened on their own, nothing in them runs on mekaweb's origin.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    app::App,
    auth::Signed,
    error::ApiError,
    sse::{Gzip, Rewriter},
};

/// The request headers passed to meka.
const FORWARDED_REQUEST_HEADERS: &[HeaderName] = &[
    header::ACCEPT,
    header::CONTENT_TYPE,
    header::IF_MATCH,
    header::IF_NONE_MATCH,
    header::CACHE_CONTROL,
];

/// More request headers passed to meka, by name.
const FORWARDED_REQUEST_NAMES: &[&str] = &["last-event-id", "idempotency-key"];

/// Response headers never passed back: they describe the connection, not the response, or ask
/// for what only meka's own address could grant.
const DROPPED_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
];

/// The header a device saving data sends, with how many milliseconds an event stream's writes may
/// wait to be sent together.
const BATCH_HEADER: &str = "x-mekaweb-batch";

/// The header a device saving data sends to leave out commands' streamed output.
const DATA_SAVER_HEADER: &str = "x-mekaweb-data-saver";

/// The header a page in front sends with its server feed: it alerts of finished turns itself, so
/// its device is not sent push notifications of them.
const FOCUSED_HEADER: &str = "x-mekaweb-focused";

/// The shortest and longest wait a device may ask for.
const BATCH_MILLIS: std::ops::RangeInclusive<u64> = 100..=2_000;

/// The policy every response from meka carries: a document opened on its own runs nothing.
const RESPONSE_POLICY: &str = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

/// How much a batch holds before it is sent anyway.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// Which devices are watching which meka sessions, and which have a page in front: a count per
/// sign-in and what its streams say of it.
#[derive(Debug, Default)]
pub(crate) struct Watching {
    counts: Mutex<HashMap<(String, Watched), usize>>,
}

/// What an open stream says of its device.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Watched {
    /// A session's feed or a streamed turn: the device sees what happens in that session.
    Session(String),
    /// A server feed sent from a page in front, which alerts in the page itself.
    Focused,
}

impl Watching {
    /// Notes that the sign-in `device` is watching `session` until the guard is dropped.
    pub(crate) fn watch(self: &Arc<Self>, device: &str, session: &str) -> WatchGuard {
        self.hold(device, Watched::Session(session.to_owned()))
    }

    /// Notes that the sign-in `device` has a page in front until the guard is dropped.
    pub(crate) fn focus(self: &Arc<Self>, device: &str) -> WatchGuard {
        self.hold(device, Watched::Focused)
    }

    fn hold(self: &Arc<Self>, device: &str, watched: Watched) -> WatchGuard {
        let key = (device.to_owned(), watched);
        *self
            .counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key.clone())
            .or_insert(0) += 1;
        WatchGuard {
            watching: Arc::clone(self),
            key,
        }
    }

    /// Whether the sign-in `device` is watching `session`.
    pub(crate) fn is_watching(&self, device: &str, session: &str) -> bool {
        self.holds(device, Watched::Session(session.to_owned()))
    }

    /// Whether the sign-in `device` has a page in front.
    pub(crate) fn is_focused(&self, device: &str) -> bool {
        self.holds(device, Watched::Focused)
    }

    fn holds(&self, device: &str, watched: Watched) -> bool {
        self.counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&(device.to_owned(), watched))
    }
}

/// A device watching a session, or with a page in front, until dropped.
#[derive(Debug)]
pub(crate) struct WatchGuard {
    watching: Arc<Watching>,
    key: (String, Watched),
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        let mut counts = self
            .watching
            .counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = counts.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

/// The meka session a path streams, if it is a session's feed or a streamed turn.
fn streamed_session(path: &str, method: &Method) -> Option<String> {
    let rest = path.strip_prefix("v1/sessions/")?;
    let (id, tail) = rest.split_once('/')?;
    let streams =
        (tail == "stream" && method == Method::GET) || (tail == "turn" && method == Method::POST);
    streams.then(|| id.to_owned())
}

/// The part of `path`, as the browser wrote it, that goes to meka: what follows `/meka/`, if it
/// is under `v1/` and has no `.` or `..` segment, however written.
fn meka_path(path: &str) -> Result<&str, ApiError> {
    let rest = path
        .strip_prefix("/meka/")
        .filter(|rest| rest.starts_with("v1/"))
        .ok_or_else(|| ApiError::not_found("meka's API is under /meka/v1/"))?;
    let is_dots = |segment: &str| {
        let decoded = percent_decode_str(segment).collect::<Vec<u8>>();
        decoded == b"." || decoded == b".."
    };
    if rest.split('/').any(is_dots) {
        return Err(ApiError::bad_request("a path to meka cannot hold . or .."));
    }
    Ok(rest)
}

/// Passes a request to meka.
pub(crate) async fn forward(
    State(app): State<App>,
    signed: Signed,
    request: Request,
) -> Result<Response, ApiError> {
    let (parts, body) = request.into_parts();
    let rest = meka_path(parts.uri.path())?;
    let mut url = app.meka.base().clone();
    url.set_path(&format!("/{rest}"));
    url.set_query(parts.uri.query());
    let decoded = percent_decode_str(url.path()).decode_utf8_lossy();
    if !url.path().starts_with("/v1/") {
        return Err(ApiError::bad_request("the path leaves meka's API"));
    }
    if decoded.eq_ignore_ascii_case("/v1/openapi.json") {
        return Err(ApiError::not_found(
            "meka's OpenAPI document is not passed through",
        ));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for name in FORWARDED_REQUEST_HEADERS {
        for value in parts.headers.get_all(name) {
            headers.append(name.clone(), value.clone());
        }
    }
    for name in FORWARDED_REQUEST_NAMES {
        if let Some(value) = parts.headers.get(*name) {
            headers.insert(HeaderName::from_static(name), value.clone());
        }
    }
    let mut token = HeaderValue::from_str(&format!("Bearer {}", app.meka.token()))
        .map_err(|error| ApiError::internal(&anyhow::anyhow!("bad meka token: {error}")))?;
    token.set_sensitive(true);
    headers.insert(header::AUTHORIZATION, token);
    let has_body = !matches!(parts.method, Method::GET | Method::HEAD);
    let mut outgoing = app
        .meka
        .client()
        .request(parts.method.clone(), url)
        .headers(headers);
    if has_body {
        outgoing = outgoing.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    let response = match outgoing.send().await {
        Ok(response) => {
            app.meka.answered();
            response
        }
        Err(error) if is_too_large(&error) => {
            return Err(ApiError::too_large(format!(
                "meka takes at most {} MiB at once",
                crate::app::MAX_MEKA_BODY_BYTES / (1024 * 1024)
            )));
        }
        Err(error) => {
            let message = if error.is_connect() || error.is_timeout() {
                app.meka.lost(&error.to_string());
                format!("mekaweb could not reach meka at {}.", app.meka.base())
            } else {
                format!("The request to meka failed: {error}")
            };
            return Err(ApiError::meka_unavailable(message));
        }
    };
    // meka refusing its token is mekaweb's trouble, not a sign that the browser is signed out.
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        app.meka.lost("meka refused mekaweb's token");
        return Err(ApiError::meka_unavailable(
            "meka refused mekaweb's token; check meka.token or meka.token_file in mekaweb's config.",
        ));
    }
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out_headers = HeaderMap::new();
    for (name, value) in response.headers() {
        if DROPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        out_headers.append(name.clone(), value.clone());
    }
    out_headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(RESPONSE_POLICY),
    );
    // meka names its own resources by its own paths.
    if let Some(location) = out_headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .filter(|location| location.starts_with("/v1/"))
        .and_then(|location| HeaderValue::from_str(&format!("/meka{location}")).ok())
    {
        out_headers.insert(header::LOCATION, location);
    }
    let is_stream = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if !is_stream {
        let mut built = Response::new(Body::from_stream(response.bytes_stream()));
        *built.status_mut() = status;
        *built.headers_mut() = out_headers;
        return Ok(built);
    }
    let gzip = accepts_gzip(&parts.headers);
    let batch = parts
        .headers
        .get(BATCH_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|millis| {
            Duration::from_millis(millis.clamp(*BATCH_MILLIS.start(), *BATCH_MILLIS.end()))
        });
    let lean = parts.headers.get(DATA_SAVER_HEADER).is_some();
    let guard = streamed_session(rest, &parts.method)
        .map(|session| app.watching.watch(&signed.session.id, &session))
        .or_else(|| {
            (rest == "v1/stream" && parts.headers.contains_key(FOCUSED_HEADER))
                .then(|| app.watching.focus(&signed.session.id))
        });
    out_headers.remove(header::CONTENT_LENGTH);
    if gzip {
        out_headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        out_headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    // Proxies that buffer, such as nginx, are told not to.
    out_headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    out_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    let (sender, receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let stream = Relay {
        gzip,
        batch,
        lean,
        guard,
    };
    let device = signed.session.id;
    tokio::spawn(async move {
        tokio::select! {
            () = stream.run(response, &sender) => {}
            () = app.auth.until_ended(&device) => {}
        }
    });
    let mut built = Response::new(Body::from_stream(ReceiverStream::new(receiver)));
    *built.status_mut() = status;
    *built.headers_mut() = out_headers;
    Ok(built.into_response())
}

/// Whether a request to meka failed for the browser's body passing the size limit.
fn is_too_large(error: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = source {
        if error.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        source = error.source();
    }
    false
}

/// Whether a request's `Accept-Encoding` takes gzip.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|part| {
            let mut pieces = part.split(';');
            let name = pieces.next().unwrap_or_default().trim();
            let refused = pieces.any(|parameter| {
                parameter
                    .trim()
                    .strip_prefix("q=")
                    .and_then(|weight| weight.trim().parse::<f32>().ok())
                    .is_some_and(|weight| weight <= 0.0)
            });
            name.eq_ignore_ascii_case("gzip") && !refused
        })
}

/// How an event stream is carried from meka to the browser.
struct Relay {
    gzip: bool,
    batch: Option<Duration>,
    lean: bool,
    guard: Option<WatchGuard>,
}

impl Relay {
    /// Carries `response`'s stream to `sender` until either end stops.
    async fn run(
        self,
        response: reqwest::Response,
        sender: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    ) {
        let Self {
            gzip,
            batch,
            lean,
            guard,
        } = self;
        let mut upstream = response.bytes_stream();
        let mut rewriter = Rewriter::new(lean);
        let mut encoder = gzip.then(Gzip::new);
        let mut pending: Vec<u8> = Vec::new();
        let mut ticker = batch.map(tokio::time::interval);
        loop {
            // The browser leaving ends the relay at once, rather than at meka's next write, so a
            // device stops counting as watching when it stops.
            let next = match &mut ticker {
                Some(ticker) => tokio::select! {
                    chunk = upstream.next() => Some(chunk),
                    _ = ticker.tick() => None,
                    () = sender.closed() => break,
                },
                None => tokio::select! {
                    chunk = upstream.next() => Some(chunk),
                    () = sender.closed() => break,
                },
            };
            match next {
                // The batch's time came: send what it holds.
                None => {
                    let out = std::mem::take(&mut pending);
                    if !forward_bytes(sender, compress(&mut encoder, out)).await {
                        break;
                    }
                }
                Some(Some(Ok(chunk))) => {
                    let Some(out) = rewrite(&mut rewriter, chunk).await else {
                        break;
                    };
                    pending.extend(out);
                    if batch.is_some() && pending.len() < MAX_BATCH_BYTES {
                        continue;
                    }
                    let out = std::mem::take(&mut pending);
                    if !forward_bytes(sender, compress(&mut encoder, out)).await {
                        break;
                    }
                }
                // meka's stream ended, or broke off: what is held goes on, and the compressed
                // stream is ended properly.
                Some(end) => {
                    if let Some(Err(error)) = end {
                        tracing::debug!("meka's event stream ended: {error}");
                    }
                    let mut out = std::mem::take(&mut pending);
                    out.extend(rewriter.finish());
                    if !forward_bytes(sender, compress(&mut encoder, out)).await {
                        break;
                    }
                    if let Some(encoder) = encoder.take() {
                        match encoder.finish() {
                            Ok(end) => {
                                if sender.send(Ok(Bytes::from(end))).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => {
                                tracing::warn!("could not end a compressed stream: {error}");
                            }
                        }
                    }
                    break;
                }
            }
        }
        drop(guard);
    }
}

/// What `rewriter` makes of `chunk`, worked out off the async runtime when it may complete a large
/// frame; `None` if that work failed.
async fn rewrite(rewriter: &mut Rewriter, chunk: Bytes) -> Option<Vec<u8>> {
    if !rewriter.is_heavy(&chunk) {
        return Some(rewriter.push(&chunk));
    }
    let mut working = std::mem::take(rewriter);
    match tokio::task::spawn_blocking(move || {
        let out = working.push(&chunk);
        (working, out)
    })
    .await
    {
        Ok((working, out)) => {
            *rewriter = working;
            Some(out)
        }
        Err(error) => {
            tracing::warn!("could not rewrite an event stream: {error}");
            None
        }
    }
}

/// `bytes` compressed by `encoder` if there is one; nothing if there are no bytes.
fn compress(encoder: &mut Option<Gzip>, bytes: Vec<u8>) -> Result<Option<Bytes>, std::io::Error> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let bytes = match encoder {
        Some(encoder) => encoder.push(&bytes)?,
        None => bytes,
    };
    Ok(Some(Bytes::from(bytes)))
}

/// Sends `bytes` on, if there are any; whether the browser is still there.
async fn forward_bytes(
    sender: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    bytes: Result<Option<Bytes>, std::io::Error>,
) -> bool {
    match bytes {
        Ok(Some(bytes)) => sender.send(Ok(bytes)).await.is_ok(),
        Ok(None) => true,
        Err(error) => {
            tracing::warn!("could not compress an event stream: {error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feed_or_a_streamed_turn_marks_its_session_watched() {
        assert_eq!(
            streamed_session("v1/sessions/abc/stream", &Method::GET).as_deref(),
            Some("abc")
        );
        assert_eq!(
            streamed_session("v1/sessions/abc/turn", &Method::POST).as_deref(),
            Some("abc")
        );
        assert_eq!(streamed_session("v1/sessions/abc", &Method::GET), None);
        assert_eq!(streamed_session("v1/stream", &Method::GET), None);
    }

    #[test]
    fn watching_lasts_while_any_stream_is_open() {
        let watching = Arc::new(Watching::default());
        let first = watching.watch("device", "session");
        let second = watching.watch("device", "session");
        assert!(watching.is_watching("device", "session"));
        drop(first);
        assert!(watching.is_watching("device", "session"));
        drop(second);
        assert!(!watching.is_watching("device", "session"));
    }

    #[test]
    fn a_page_in_front_marks_its_own_device_alone() {
        let watching = Arc::new(Watching::default());
        let focused = watching.focus("device");
        assert!(watching.is_focused("device"));
        assert!(!watching.is_focused("other"));
        assert!(!watching.is_watching("device", ""));
        drop(focused);
        assert!(!watching.is_focused("device"));
    }

    #[test]
    fn a_path_to_meka_keeps_its_encoding_and_has_no_dot_segments() {
        assert_eq!(
            meka_path("/meka/v1/memory/a%2Fb%3Fc").ok(),
            Some("v1/memory/a%2Fb%3Fc")
        );
        for path in [
            "/meka/v1/x/../openapi.json",
            "/meka/v1/x/%2e%2E/openapi.json",
            "/meka/v1/%2e/openapi.json",
            "/meka/v1/sessions/.",
            "/meka/v2/x",
            "/meka/",
        ] {
            assert!(meka_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn gzip_is_taken_unless_refused() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip, deflate, br"),
        );
        assert!(accepts_gzip(&headers));
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br, gzip;q=0"),
        );
        assert!(!accepts_gzip(&headers));
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip; q=0.000"),
        );
        assert!(!accepts_gzip(&headers));
    }
}
