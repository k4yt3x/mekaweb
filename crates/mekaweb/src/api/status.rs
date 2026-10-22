//! How mekaweb and meka stand.

use axum::{
    Json,
    extract::{Query, State},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    app::App,
    auth::Signed,
    meka::{MekaStatus, Versions},
};

/// What this mekaweb offers.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Features {
    /// Whether terminals may be opened.
    pub(crate) terminal: bool,
    /// Whether push notifications can be sent.
    pub(crate) push: bool,
}

/// How mekaweb and meka stand.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct StatusView {
    /// mekaweb's version.
    pub(crate) version: String,
    /// How meka stood at the last check.
    pub(crate) meka: MekaStatus,
    /// The meka versions this release supports.
    pub(crate) versions: Versions,
    /// What this mekaweb offers.
    pub(crate) features: Features,
}

#[utoipa::path(
    get,
    path = "/api/status",
    tag = "status",
    params(("check" = Option<bool>, Query, description = "Check meka again before answering")),
    responses((status = 200, body = StatusView))
)]
pub(crate) async fn status(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<CheckQuery>,
) -> Json<StatusView> {
    let meka = if query.check.unwrap_or(false) {
        app.meka.check().await
    } else {
        app.meka.status()
    };
    Json(StatusView {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        meka,
        versions: app.meka.versions().clone(),
        features: Features {
            terminal: app.config.terminal.enabled,
            push: app.push.is_enabled(),
        },
    })
}

/// Whether to check meka again first.
#[derive(Debug, Deserialize)]
pub(crate) struct CheckQuery {
    pub(crate) check: Option<bool>,
}
