//! Push notifications' endpoints: the key to subscribe with, this device's subscription, and a
//! test.

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    app::App,
    auth::Signed,
    error::{ApiError, ApiResult},
    push::{Message, PushError, PushKind, crypto::Receiver},
};

/// Whether push notifications work, and whether this device receives them.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct PushState {
    /// Whether mekaweb can send them.
    pub(crate) enabled: bool,
    /// The key to subscribe with, uncompressed, in URL-safe base64.
    pub(crate) public_key: String,
    /// Whether this device is subscribed.
    pub(crate) subscribed: bool,
    /// The endpoint this device subscribed with, to tell whether the browser's is the same.
    pub(crate) endpoint: Option<String>,
}

/// A browser's push subscription, as `PushSubscription.toJSON()` writes it.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct Subscription {
    pub(crate) endpoint: String,
    pub(crate) keys: SubscriptionKeys,
}

/// A subscription's keys.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SubscriptionKeys {
    pub(crate) p256dh: String,
    pub(crate) auth: String,
}

impl From<PushError> for ApiError {
    fn from(error: PushError) -> Self {
        match error {
            PushError::Disabled => Self::disabled(error.to_string()),
            PushError::NotSubscribed => Self::conflict(error.to_string()),
            PushError::Gone => Self::new(
                StatusCode::GONE,
                "push-gone",
                "Subscription gone",
                error.to_string(),
            ),
            PushError::Refused(_) => Self::new(
                StatusCode::BAD_GATEWAY,
                "push-refused",
                "Push refused",
                error.to_string(),
            ),
            PushError::Internal(error) => Self::internal(&error),
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/push",
    tag = "push",
    responses((status = 200, body = PushState))
)]
pub(crate) async fn push_state(
    State(app): State<App>,
    signed: Signed,
) -> ApiResult<Json<PushState>> {
    let subscription = app.store.subscription(&signed.session.id).await?;
    Ok(Json(PushState {
        enabled: app.push.is_enabled(),
        public_key: app.push.public_key().to_owned(),
        subscribed: subscription.is_some(),
        endpoint: subscription.map(|subscription| subscription.endpoint),
    }))
}

#[utoipa::path(
    put,
    path = "/api/push/subscription",
    tag = "push",
    request_body = Subscription,
    responses((status = 204), (status = 400, body = crate::error::Problem), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn subscribe(
    State(app): State<App>,
    signed: Signed,
    Json(body): Json<Subscription>,
) -> ApiResult<StatusCode> {
    if !app.push.is_enabled() {
        return Err(PushError::Disabled.into());
    }
    let endpoint = url::Url::parse(&body.endpoint)
        .map_err(|_| ApiError::bad_request("the subscription's endpoint is not an address"))?;
    if !crate::push::is_push_service(&endpoint) {
        return Err(ApiError::bad_request(
            "the subscription's endpoint is not a push service mekaweb knows",
        ));
    }
    Receiver::from_base64(&body.keys.p256dh, &body.keys.auth)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    app.store
        .set_subscription(
            &signed.session.id,
            endpoint.as_str(),
            &body.keys.p256dh,
            &body.keys.auth,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/api/push/subscription",
    tag = "push",
    responses((status = 204))
)]
pub(crate) async fn unsubscribe(State(app): State<App>, signed: Signed) -> ApiResult<StatusCode> {
    app.store
        .delete_session_subscription(&signed.session.id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/push/test",
    tag = "push",
    responses(
        (status = 204, description = "The push service took the notification"),
        (status = 409, description = "This device is not subscribed", body = crate::error::Problem),
        (status = 410, description = "The push service no longer knows this device", body = crate::error::Problem),
        (status = 502, body = crate::error::Problem)
    )
)]
pub(crate) async fn test_push(State(app): State<App>, signed: Signed) -> ApiResult<StatusCode> {
    let subscription = app
        .store
        .subscription(&signed.session.id)
        .await?
        .ok_or(PushError::NotSubscribed)?;
    app.push
        .send(&subscription, &Message {
            kind: PushKind::Test,
            session: None,
            title: "mekaweb".to_owned(),
            badge: None,
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
