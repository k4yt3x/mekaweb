//! Signing in and out, and confirming who you are before something risky.

use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    app::App,
    auth::{Client, FRESH_WINDOW, SignInError, Signed, device_name, passkeys},
    error::{ApiError, ApiResult},
    store::SessionRow,
};

/// Who is signed in, on which device, and what they can confirm themselves with.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionView {
    /// The username.
    pub(crate) username: String,
    /// This sign-in's id, as the devices list names it.
    pub(crate) device_id: String,
    /// What this device is called.
    pub(crate) device_name: String,
    /// When the person last confirmed who they are on this device.
    pub(crate) verified_at: Option<DateTime<Utc>>,
    /// How long a confirmation counts for a risky change, in seconds.
    pub(crate) fresh_seconds: u64,
    /// Whether passkeys work at this address.
    pub(crate) passkeys_available: bool,
    /// Whether the user has a passkey.
    pub(crate) has_passkeys: bool,
}

/// A username and password.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct PasswordSignIn {
    pub(crate) username: String,
    pub(crate) password: String,
}

/// A challenge for the browser to put to an authenticator.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct PasskeyChallenge {
    /// The id the answer comes back with.
    pub(crate) id: String,
    /// The options for `navigator.credentials`, with their bytes in URL-safe base64.
    #[schema(value_type = Object)]
    pub(crate) options: serde_json::Value,
}

/// A passkey's answer to a challenge.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct PasskeyAnswer {
    /// The challenge's id.
    pub(crate) challenge: String,
    /// The credential the browser returned, with its bytes in URL-safe base64.
    #[schema(value_type = Object)]
    pub(crate) credential: serde_json::Value,
}

/// Confirming who you are: a passkey's answer, or the password where there is no passkey.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct Confirmation {
    pub(crate) password: Option<String>,
    pub(crate) challenge: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub(crate) credential: Option<serde_json::Value>,
}

/// When the person confirmed who they are.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Confirmed {
    pub(crate) verified_at: DateTime<Utc>,
}

impl From<passkeys::PasskeyError> for ApiError {
    fn from(error: passkeys::PasskeyError) -> Self {
        match error {
            passkeys::PasskeyError::Internal(error) => Self::internal(&error),
            passkeys::PasskeyError::Taken => Self::conflict(error.to_string()),
            passkeys::PasskeyError::Unavailable | passkeys::PasskeyError::NoPasskeys => Self::new(
                StatusCode::CONFLICT,
                "passkeys-unavailable",
                "Passkeys unavailable",
                error.to_string(),
            ),
            passkeys::PasskeyError::Expired | passkeys::PasskeyError::Refused => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "passkey-refused",
                "Passkey refused",
                error.to_string(),
            ),
        }
    }
}

impl From<SignInError> for ApiError {
    fn from(error: SignInError) -> Self {
        match error {
            SignInError::Wrong => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "wrong-credentials",
                "Wrong username or password",
                "The username or password is wrong.",
            ),
            SignInError::Limited(wait) => Self::too_many(wait.as_secs().max(1)),
            SignInError::Passkey(error) => error.into(),
            SignInError::Internal(error) => Self::internal(&error),
        }
    }
}

/// What the session view says of `session`.
pub(crate) async fn session_view(app: &App, signed: &Signed) -> ApiResult<SessionView> {
    let has_passkeys = !app.store.passkeys(signed.user.id).await?.is_empty();
    Ok(SessionView {
        username: signed.user.username.clone(),
        device_id: signed.session.id.clone(),
        device_name: shown_name(&signed.session),
        verified_at: signed.session.verified_at,
        fresh_seconds: FRESH_WINDOW.as_secs(),
        passkeys_available: app.auth.passkeys.is_available(),
        has_passkeys,
    })
}

/// What a device is called: its own name, or one from its browser.
pub(crate) fn shown_name(session: &SessionRow) -> String {
    session
        .name
        .clone()
        .unwrap_or_else(|| device_name(&session.user_agent))
}

/// A response that signs in with `token`.
async fn signed_in(app: &App, session: SessionRow, token: &str) -> ApiResult<Response> {
    let user = app
        .store
        .user_by_id(session.user_id)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let signed = Signed { session, user };
    let view = session_view(app, &signed).await?;
    Ok((
        [(header::SET_COOKIE, app.auth.session_cookie(token))],
        Json(view),
    )
        .into_response())
}

#[utoipa::path(
    get,
    path = "/api/auth/session",
    tag = "auth",
    responses(
        (status = 200, body = SessionView),
        (status = 401, description = "Nobody is signed in", body = crate::error::Problem)
    )
)]
pub(crate) async fn session(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<SessionView>> {
    Ok(Json(session_view(&app, &signed).await?))
}

#[utoipa::path(
    post,
    path = "/api/auth/password",
    tag = "auth",
    request_body = PasswordSignIn,
    responses(
        (status = 200, description = "Signed in; the cookie is set", body = SessionView),
        (status = 422, body = crate::error::Problem),
        (status = 429, body = crate::error::Problem)
    )
)]
pub(crate) async fn sign_in_with_password(
    State(app): State<App>,
    client: Client,
    Json(body): Json<PasswordSignIn>,
) -> ApiResult<Response> {
    let (session, token) = app
        .auth
        .sign_in_with_password(body.username.trim(), &body.password, &client)
        .await?;
    signed_in(&app, session, &token).await
}

#[utoipa::path(
    post,
    path = "/api/auth/passkey/challenge",
    tag = "auth",
    responses(
        (status = 200, body = PasskeyChallenge),
        (status = 409, description = "Passkeys do not work at this address", body = crate::error::Problem),
        (status = 429, body = crate::error::Problem)
    )
)]
pub(crate) async fn passkey_sign_in_challenge(
    State(app): State<App>,
    client: Client,
) -> ApiResult<Json<PasskeyChallenge>> {
    app.auth.limit_challenge(&client)?;
    let challenge = app.auth.passkeys.start_sign_in()?;
    Ok(Json(PasskeyChallenge {
        id: challenge.id,
        options: challenge.options,
    }))
}

#[utoipa::path(
    post,
    path = "/api/auth/passkey",
    tag = "auth",
    request_body = PasskeyAnswer,
    responses(
        (status = 200, description = "Signed in; the cookie is set", body = SessionView),
        (status = 422, body = crate::error::Problem),
        (status = 429, body = crate::error::Problem)
    )
)]
pub(crate) async fn sign_in_with_passkey(
    State(app): State<App>,
    client: Client,
    Json(body): Json<PasskeyAnswer>,
) -> ApiResult<Response> {
    let (session, token) = app
        .auth
        .sign_in_with_passkey(&body.challenge, &body.credential, &client)
        .await?;
    signed_in(&app, session, &token).await
}

#[utoipa::path(
    post,
    path = "/api/auth/sign-out",
    tag = "auth",
    responses((status = 204, description = "Signed out; the cookie is removed"))
)]
pub(crate) async fn sign_out(State(app): State<App>, signed: Signed) -> ApiResult<Response> {
    app.store
        .delete_session(signed.user.id, &signed.session.id)
        .await?;
    app.auth.sessions_ended();
    // The browser forgets what it kept of the account's pages and files.
    Ok((StatusCode::NO_CONTENT, [
        (header::SET_COOKIE, app.auth.clear_cookie()),
        (
            header::HeaderName::from_static("clear-site-data"),
            "\"cache\"".to_owned(),
        ),
    ])
        .into_response())
}

#[utoipa::path(
    post,
    path = "/api/auth/confirm/challenge",
    tag = "auth",
    responses(
        (status = 200, body = PasskeyChallenge),
        (status = 409, description = "There is no passkey to confirm with; confirm with the password", body = crate::error::Problem)
    )
)]
pub(crate) async fn confirm_challenge(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<PasskeyChallenge>> {
    let challenge = app
        .auth
        .passkeys
        .start_confirm(&app.store, &signed.user, &signed.session.id)
        .await?;
    Ok(Json(PasskeyChallenge {
        id: challenge.id,
        options: challenge.options,
    }))
}

#[utoipa::path(
    post,
    path = "/api/auth/confirm",
    tag = "auth",
    request_body = Confirmation,
    responses(
        (status = 200, body = Confirmed),
        (status = 422, body = crate::error::Problem),
        (status = 429, body = crate::error::Problem)
    )
)]
pub(crate) async fn confirm(
    State(app): State<App>,
    signed: Signed,
    client: Client,
    Json(body): Json<Confirmation>,
) -> ApiResult<Json<Confirmed>> {
    let has_passkeys = !app.store.passkeys(signed.user.id).await?.is_empty();
    match (body.challenge, body.credential, body.password) {
        (Some(challenge), Some(credential), _) => {
            app.auth.limit_confirm(&signed.session.id)?;
            let result = app
                .auth
                .passkeys
                .finish_confirm(
                    &app.store,
                    &signed.user,
                    &signed.session.id,
                    &challenge,
                    &credential,
                )
                .await;
            let outcome = if result.is_ok() {
                "confirmed"
            } else {
                "refused"
            };
            app.auth
                .log(&signed.user.username, &client, "confirm-passkey", outcome)
                .await;
            result?;
        }
        // A passkey, where there is one, is the stronger check, and the one asked for.
        (_, _, Some(_)) if has_passkeys && app.auth.passkeys.is_available() => {
            return Err(ApiError::bad_request("confirm with one of your passkeys"));
        }
        (_, _, Some(password)) => {
            app.auth.limit_confirm(&signed.session.id)?;
            let right = app
                .auth
                .hasher()
                .verify(&password, Some(&signed.user.password_hash))
                .await?;
            let outcome = if right { "confirmed" } else { "wrong" };
            app.auth
                .log(&signed.user.username, &client, "confirm-password", outcome)
                .await;
            if !right {
                return Err(SignInError::Wrong.into());
            }
        }
        _ => {
            return Err(ApiError::bad_request(
                "send a passkey's answer or the password",
            ));
        }
    }
    let verified_at = app.store.verify_session(&signed.session.id).await?;
    Ok(Json(Confirmed { verified_at }))
}
