//! The account: passkeys, the password, the devices signed in, the sign-in log, and the
//! preferences every device shares.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::auth::{PasskeyChallenge, shown_name};
use crate::{
    app::App,
    auth::{
        Client, FRESH_WINDOW, Signed, device_details, device_name,
        password::{PasswordProblem, check_password},
    },
    error::{ApiError, ApiResult},
};

/// The longest a device's name may be.
const MAX_DEVICE_NAME_CHARS: usize = 60;

/// The largest the synced preferences may be, as JSON.
const MAX_PREFERENCES_BYTES: usize = 16 * 1024;

/// A passkey.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct PasskeyView {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) last_used_at: Option<DateTime<Utc>>,
}

/// A new passkey: the authenticator's answer and what to call it.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewPasskey {
    pub(crate) challenge: String,
    #[schema(value_type = Object)]
    pub(crate) credential: serde_json::Value,
    pub(crate) name: String,
}

/// A new name.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct Rename {
    /// The name; empty goes back to the default.
    pub(crate) name: String,
}

/// A new password, and the one it replaces.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewPassword {
    /// The password now.
    pub(crate) current: String,
    pub(crate) password: String,
}

/// A device signed in.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeviceView {
    pub(crate) id: String,
    /// What it is called: its own name, or one from its browser.
    pub(crate) name: String,
    /// Whether the person named it.
    pub(crate) named: bool,
    /// Its browser and system, with their versions, from its user agent.
    pub(crate) device: String,
    pub(crate) user_agent: String,
    /// How it signed in: `password` or `passkey`.
    pub(crate) method: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) last_seen_at: DateTime<Utc>,
    pub(crate) last_ip: String,
    /// Whether it is the device asking.
    pub(crate) current: bool,
    /// Whether it receives push notifications.
    pub(crate) push: bool,
}

/// How many devices were signed out.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SignedOut {
    pub(crate) count: usize,
}

/// A sign-in attempt.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LogEntryView {
    pub(crate) at: DateTime<Utc>,
    pub(crate) username: String,
    pub(crate) ip: String,
    /// The device, named from its browser.
    pub(crate) device: String,
    /// `password`, `passkey`, `confirm-password`, `confirm-passkey` or `change-password`.
    pub(crate) method: String,
    /// `signed-in`, `confirmed`, `wrong` or `refused`.
    pub(crate) outcome: String,
}

/// The preferences every device shares, as the interface writes them.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct Preferences {
    #[schema(value_type = Object)]
    pub(crate) value: serde_json::Value,
}

#[utoipa::path(
    get,
    path = "/api/account/passkeys",
    tag = "account",
    responses((status = 200, body = Vec<PasskeyView>))
)]
pub(crate) async fn passkeys(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<Vec<PasskeyView>>> {
    let rows = app.store.passkeys(signed.user.id).await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| PasskeyView {
                id: row.id,
                name: row.name,
                created_at: row.created_at,
                last_used_at: row.last_used_at,
            })
            .collect(),
    ))
}

#[utoipa::path(
    post,
    path = "/api/account/passkeys/challenge",
    tag = "account",
    responses(
        (status = 200, body = PasskeyChallenge),
        (status = 403, description = "Confirm who you are first", body = crate::error::Problem)
    )
)]
pub(crate) async fn passkey_challenge(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<PasskeyChallenge>> {
    signed.require_fresh(FRESH_WINDOW)?;
    let challenge = app
        .auth
        .passkeys
        .start_registration(&app.store, &signed.user, &signed.session.id)
        .await?;
    Ok(Json(PasskeyChallenge {
        id: challenge.id,
        options: challenge.options,
    }))
}

#[utoipa::path(
    post,
    path = "/api/account/passkeys",
    tag = "account",
    request_body = NewPasskey,
    responses(
        (status = 200, body = PasskeyView),
        (status = 403, body = crate::error::Problem),
        (status = 422, body = crate::error::Problem)
    )
)]
pub(crate) async fn add_passkey(
    State(app): State<App>,
    signed: Signed,
    Json(body): Json<NewPasskey>,
) -> ApiResult<Json<PasskeyView>> {
    signed.require_fresh(FRESH_WINDOW)?;
    let row = app
        .auth
        .passkeys
        .finish_registration(
            &app.store,
            &signed.user,
            &signed.session.id,
            &body.name,
            &body.challenge,
            &body.credential,
        )
        .await?;
    Ok(Json(PasskeyView {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
    }))
}

#[utoipa::path(
    patch,
    path = "/api/account/passkeys/{id}",
    tag = "account",
    request_body = Rename,
    params(("id" = String, Path)),
    responses((status = 204), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn rename_passkey(
    State(app): State<App>,
    signed: Signed,
    Path(id): Path<String>,
    Json(body): Json<Rename>,
) -> ApiResult<StatusCode> {
    let name = crate::auth::passkeys::passkey_name(&body.name);
    if app.store.rename_passkey(signed.user.id, &id, &name).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("there is no such passkey"))
    }
}

#[utoipa::path(
    delete,
    path = "/api/account/passkeys/{id}",
    tag = "account",
    params(("id" = String, Path)),
    responses((status = 204), (status = 403, body = crate::error::Problem), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn remove_passkey(
    State(app): State<App>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    signed.require_fresh(FRESH_WINDOW)?;
    if app.store.delete_passkey(signed.user.id, &id).await? {
        tracing::info!("a passkey was removed");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("there is no such passkey"))
    }
}

#[utoipa::path(
    put,
    path = "/api/account/password",
    tag = "account",
    request_body = NewPassword,
    responses(
        (status = 200, description = "Changed; every other device is signed out", body = SignedOut),
        (status = 403, description = "The current password is wrong", body = crate::error::Problem),
        (status = 422, body = crate::error::Problem),
        (status = 429, body = crate::error::Problem)
    )
)]
pub(crate) async fn change_password(
    State(app): State<App>,
    signed: Signed,
    client: Client,
    Json(body): Json<NewPassword>,
) -> ApiResult<Json<SignedOut>> {
    // The current password is what a change needs, checked as a confirmation is: limited for the
    // device, and logged.
    app.auth.limit_confirm(&signed.session.id)?;
    let right = app
        .auth
        .hasher()
        .verify(&body.current, Some(&signed.user.password_hash))
        .await?;
    app.auth
        .log(
            &signed.user.username,
            &client,
            "change-password",
            if right { "confirmed" } else { "wrong" },
        )
        .await;
    if !right {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "wrong-password",
            "Wrong password",
            "The current password is wrong.",
        ));
    }
    if let Err(problem) = check_password(&body.password, &signed.user.username) {
        return Err(password_problem(problem));
    }
    let hash = app.auth.hasher().hash(&body.password).await?;
    app.store.set_password(signed.user.id, &hash).await?;
    // Whoever knew the old password and signed in with it is signed out.
    let count = app
        .store
        .delete_other_sessions(signed.user.id, Some(&signed.session.id))
        .await?;
    app.auth.sessions_ended();
    tracing::info!("the password was changed; {count} other devices were signed out");
    Ok(Json(SignedOut { count }))
}

/// A password that cannot be used, as an answer.
fn password_problem(problem: PasswordProblem) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "weak-password",
        "Password not accepted",
        format!("{}.", capitalized(&problem.to_string())),
    )
}

fn capitalized(text: &str) -> String {
    let mut characters = text.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => String::new(),
    }
}

#[utoipa::path(
    get,
    path = "/api/account/devices",
    tag = "account",
    responses((status = 200, body = Vec<DeviceView>))
)]
pub(crate) async fn devices(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<Vec<DeviceView>>> {
    let sessions = app.store.sessions(signed.user.id).await?;
    let subscribed: std::collections::HashSet<String> = app
        .store
        .subscriptions()
        .await?
        .into_iter()
        .map(|subscription| subscription.session_id)
        .collect();
    Ok(Json(
        sessions
            .into_iter()
            .map(|session| DeviceView {
                name: shown_name(&session),
                named: session.name.is_some(),
                device: device_details(&session.user_agent),
                current: session.id == signed.session.id,
                push: subscribed.contains(&session.id),
                id: session.id,
                user_agent: session.user_agent,
                method: session.method,
                created_at: session.created_at,
                last_seen_at: session.last_seen_at,
                last_ip: session.last_ip,
            })
            .collect(),
    ))
}

#[utoipa::path(
    patch,
    path = "/api/account/devices/{id}",
    tag = "account",
    request_body = Rename,
    params(("id" = String, Path)),
    responses((status = 204), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn rename_device(
    State(app): State<App>,
    signed: Signed,
    Path(id): Path<String>,
    Json(body): Json<Rename>,
) -> ApiResult<StatusCode> {
    let name = crate::auth::passkeys::tidy_name(&body.name, MAX_DEVICE_NAME_CHARS);
    let name = (!name.is_empty()).then_some(name);
    if app
        .store
        .rename_session(signed.user.id, &id, name.as_deref())
        .await?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("there is no such device"))
    }
}

#[utoipa::path(
    delete,
    path = "/api/account/devices/{id}",
    tag = "account",
    params(("id" = String, Path)),
    responses((status = 204), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn sign_out_device(
    State(app): State<App>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if app.store.delete_session(signed.user.id, &id).await? {
        app.auth.sessions_ended();
        tracing::info!("a device was signed out");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("there is no such device"))
    }
}

#[utoipa::path(
    post,
    path = "/api/account/devices/sign-out-others",
    tag = "account",
    responses((status = 200, body = SignedOut))
)]
pub(crate) async fn sign_out_others(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<SignedOut>> {
    let count = app
        .store
        .delete_other_sessions(signed.user.id, Some(&signed.session.id))
        .await?;
    app.auth.sessions_ended();
    Ok(Json(SignedOut { count }))
}

#[utoipa::path(
    get,
    path = "/api/account/log",
    tag = "account",
    responses((status = 200, body = Vec<LogEntryView>))
)]
pub(crate) async fn sign_in_log(
    State(app): State<App>,
    _signed: Signed,
) -> ApiResult<Json<Vec<LogEntryView>>> {
    let entries = app.store.log_entries(200).await?;
    Ok(Json(
        entries
            .into_iter()
            .map(|entry| LogEntryView {
                device: device_name(&entry.user_agent),
                at: entry.at,
                username: entry.username,
                ip: entry.ip,
                method: entry.method,
                outcome: entry.outcome,
            })
            .collect(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/preferences",
    tag = "account",
    responses((status = 200, body = Preferences))
)]
pub(crate) async fn preferences(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<Preferences>> {
    let value = match app.store.preferences(signed.user.id).await? {
        Some(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!("the saved preferences do not read: {error}");
            serde_json::Value::Object(serde_json::Map::new())
        }),
        None => serde_json::Value::Object(serde_json::Map::new()),
    };
    Ok(Json(Preferences { value }))
}

#[utoipa::path(
    put,
    path = "/api/preferences",
    tag = "account",
    request_body = Preferences,
    responses((status = 204), (status = 400, body = crate::error::Problem))
)]
pub(crate) async fn save_preferences(
    State(app): State<App>,
    signed: Signed,
    Json(body): Json<Preferences>,
) -> ApiResult<StatusCode> {
    if !body.value.is_object() {
        return Err(ApiError::bad_request("preferences are an object"));
    }
    let text = serde_json::to_string(&body.value).map_err(anyhow::Error::from)?;
    if text.len() > MAX_PREFERENCES_BYTES {
        return Err(ApiError::bad_request("the preferences are too large"));
    }
    app.store.set_preferences(signed.user.id, &text).await?;
    Ok(StatusCode::NO_CONTENT)
}
