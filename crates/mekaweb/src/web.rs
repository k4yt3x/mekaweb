//! The web interface, built into `web/dist` and compiled into the binary (read from disk in debug
//! builds). The build writes a Brotli and a gzip copy beside each text file, which are served to a
//! browser that takes them. Files under `assets/` carry a hash of their content in their names and
//! are cached for good; everything else is checked every time. Every response carries headers that
//! keep the browser to what the interface needs.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

use crate::error::ApiError;

/// The built interface, without its source maps.
#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[exclude = "*.map"]
#[allow_missing = true]
struct Web;

/// The security headers every response gets, unless its handler set its own.
#[derive(Clone)]
pub(crate) struct SecurityHeaders(Arc<Vec<(HeaderName, HeaderValue)>>);

impl SecurityHeaders {
    /// The headers for mekaweb at `origin`: the interface loads nothing from elsewhere, and a site
    /// reached over HTTPS tells browsers never to try it without. Styles may be inline, which
    /// KaTeX's markup and mermaid's diagrams need.
    pub(crate) fn new(origin: &url::Url) -> anyhow::Result<Self> {
        let https = origin.scheme() == "https";
        // Safari matched `'self'` to WebSockets only from 15.4 on; the terminal's address is named
        // outright for older ones.
        let socket = format!(
            "{}://{}",
            if https { "wss" } else { "ws" },
            origin.host_str().unwrap_or_default()
        );
        let socket = match origin.port() {
            Some(port) => format!("{socket}:{port}"),
            None => socket,
        };
        let policy = format!(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; \
             connect-src 'self' {socket}; worker-src 'self'; manifest-src 'self'; \
             frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; \
             frame-ancestors 'none'"
        );
        let transport = https.then_some((header::STRICT_TRANSPORT_SECURITY, "max-age=31536000"));
        let headers = [
            (header::CONTENT_SECURITY_POLICY, policy.as_str()),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (
                HeaderName::from_static("permissions-policy"),
                "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            ),
            (
                HeaderName::from_static("cross-origin-opener-policy"),
                "same-origin",
            ),
            (
                HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
        ]
        .into_iter()
        .chain(transport)
        .map(|(name, value)| Ok((name, HeaderValue::from_str(value)?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self(Arc::new(headers)))
    }
}

/// Adds the security headers to a response that lacks them.
pub(crate) async fn security_headers(
    State(headers): State<SecurityHeaders>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let present = response.headers_mut();
    for (name, value) in headers.0.iter() {
        if !present.contains_key(name) {
            present.insert(name.clone(), value.clone());
        }
    }
    response
}

/// Whether the interface was built into this binary.
pub(crate) fn is_built() -> bool {
    Web::get("index.html").is_some()
}

/// Serves a file of the web interface. Routes live in the address's fragment, so anything else is
/// not found: a page left open from an earlier build reloads rather than reading the index as a
/// script.
pub(crate) async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") || path == "meka" || path.starts_with("meka/") {
        return ApiError::not_found(format!("there is no endpoint {}", uri.path())).into_response();
    }
    let file = if path.is_empty() { "index.html" } else { path };
    // The compressed copies are served in their originals' place, never asked for by name.
    if file.ends_with(".br") || file.ends_with(".gz") {
        return (StatusCode::NOT_FOUND, "No such file.").into_response();
    }
    let Some(original) = Web::get(file) else {
        if file == "index.html" {
            return (
                StatusCode::NOT_FOUND,
                "The web interface is not built into this mekaweb. Run `npm ci && npm run build` in web/, then build mekaweb again.",
            )
                .into_response();
        }
        return (StatusCode::NOT_FOUND, "No such file.").into_response();
    };
    let accepts = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let accepts = |coding: &str| {
        accepts.split(',').any(|part| {
            let mut pieces = part.split(';');
            let name = pieces.next().unwrap_or_default().trim();
            let refused = pieces.any(|parameter| {
                parameter
                    .trim()
                    .strip_prefix("q=")
                    .is_some_and(|quality| quality.trim().parse::<f32>().is_ok_and(|q| q == 0.0))
            });
            name.eq_ignore_ascii_case(coding) && !refused
        })
    };
    let (content, encoding) = [("br", ".br"), ("gzip", ".gz")]
        .into_iter()
        .filter(|(coding, _)| accepts(coding))
        .find_map(|(coding, suffix)| {
            Web::get(&format!("{file}{suffix}")).map(|content| (content, Some(coding)))
        })
        .unwrap_or((original, None));
    let mime = mime_guess::from_path(file).first_or_octet_stream();
    let cache = if file.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, cache.to_owned()),
            (header::VARY, "Accept-Encoding".to_owned()),
        ],
        content.data.into_owned(),
    )
        .into_response();
    if let Some(encoding) = encoding {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    response
}
