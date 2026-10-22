//! Errors as API responses: RFC 9457 problem details, the shape meka answers with too, so the
//! interface reads mekaweb's refusals and meka's the same way. `type` is `urn:mekaweb:<kind>`.

use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use utoipa::ToSchema;

/// A problem, as the API answers it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct Problem {
    /// `urn:mekaweb:` and what kind of problem it is.
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// The kind of problem, in words.
    pub(crate) title: String,
    /// The HTTP status.
    pub(crate) status: u16,
    /// What went wrong this time.
    pub(crate) detail: String,
}

/// An error a handler answers with.
#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    kind: &'static str,
    title: &'static str,
    detail: String,
    retry_after: Option<u64>,
}

impl ApiError {
    /// An error of `status` and `kind`, titled `title`, saying `detail`.
    pub(crate) fn new(
        status: StatusCode,
        kind: &'static str,
        title: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            status,
            kind,
            title,
            detail: detail.into(),
            retry_after: None,
        }
    }

    /// The request was malformed or asked for something impossible.
    pub(crate) fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "Invalid request",
            detail,
        )
    }

    /// Nobody is signed in, or the sign-in ended.
    pub(crate) fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "signed-out",
            "Signed out",
            "Sign in to continue.",
        )
    }

    /// The signed-in person must confirm who they are again first.
    pub(crate) fn verification_required() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "verification-required",
            "Confirm it's you",
            "Confirm it's you with a passkey or your password, then try again.",
        )
    }

    /// The request came from another site.
    pub(crate) fn forbidden_origin() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "cross-origin",
            "Cross-origin request",
            "This request did not come from mekaweb's own pages.",
        )
    }

    /// The thing asked for is not there.
    pub(crate) fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not-found", "Not found", detail)
    }

    /// The request clashes with how things stand.
    pub(crate) fn conflict(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", "Conflict", detail)
    }

    /// The feature is turned off in the config.
    pub(crate) fn disabled(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "disabled", "Turned off", detail)
    }

    /// Too many tries; try again after `seconds`.
    pub(crate) fn too_many(seconds: u64) -> Self {
        let mut error = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate-limited",
            "Too many attempts",
            format!("Too many attempts. Try again in {seconds} seconds."),
        );
        error.retry_after = Some(seconds);
        error
    }

    /// The request's body is larger than it may be.
    pub(crate) fn too_large(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too-large",
            "Too large",
            detail,
        )
    }

    /// meka did not answer.
    pub(crate) fn meka_unavailable(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "meka-unavailable",
            "meka is unavailable",
            detail,
        )
    }

    /// Something failed on mekaweb's side; the log says what.
    pub(crate) fn internal(error: &anyhow::Error) -> Self {
        tracing::error!("{error:#}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Internal error",
            "mekaweb could not complete this request; its log says why.",
        )
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(&error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let problem = Problem {
            kind: format!("urn:mekaweb:{}", self.kind),
            title: self.title.to_owned(),
            status: self.status.as_u16(),
            detail: self.detail,
        };
        let mut response = (self.status, axum::Json(problem)).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let Some(seconds) = self.retry_after
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

/// What a handler returns.
pub(crate) type ApiResult<T> = Result<T, ApiError>;
