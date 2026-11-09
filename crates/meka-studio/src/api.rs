//! Meka Studio's own API, under `/api/`: signing in, the account and its devices, synced
//! preferences, how Meka stands, Files and git, terminals and push notifications. Its OpenAPI
//! document is what `meka-studio openapi` prints, from which the interface's types are generated.

pub(crate) mod account;
pub(crate) mod auth;
pub(crate) mod files;
pub(crate) mod git;
pub(crate) mod push;
pub(crate) mod status;
pub(crate) mod terminal;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, put},
};
use utoipa::OpenApi;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::app::App;

/// The largest JSON body the API takes.
const MAX_JSON_BYTES: usize = 256 * 1024;

/// The largest body a file's text is saved with: the most it may hold, room made for escaping.
const MAX_SAVE_BYTES: usize = 3 * crate::files::MAX_EDIT_BYTES as usize;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Meka Studio",
        description = "The web interface for Meka, served from the Meka host.",
        license(name = "AGPL-3.0-or-later")
    ),
    components(schemas(crate::error::Problem))
)]
struct ApiDoc;

/// The API's documented routes.
pub(crate) fn routes() -> OpenApiRouter<App> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(auth::session))
        .routes(routes!(auth::sign_in_with_password))
        .routes(routes!(auth::passkey_sign_in_challenge))
        .routes(routes!(auth::sign_in_with_passkey))
        .routes(routes!(auth::sign_out))
        .routes(routes!(auth::confirm_challenge))
        .routes(routes!(auth::confirm))
        .routes(routes!(account::passkeys))
        .routes(routes!(account::passkey_challenge))
        .routes(routes!(account::add_passkey))
        .routes(routes!(account::rename_passkey, account::remove_passkey))
        .routes(routes!(account::change_password))
        .routes(routes!(account::devices))
        .routes(routes!(account::rename_device, account::sign_out_device))
        .routes(routes!(account::sign_out_others))
        .routes(routes!(account::sign_in_log))
        .routes(routes!(account::preferences, account::save_preferences))
        .routes(routes!(status::status))
        .routes(routes!(files::list))
        .routes(routes!(files::watch))
        .routes(routes!(files::raw))
        .routes(routes!(files::zip))
        .routes(routes!(files::select_for_zip))
        .routes(routes!(files::make_folder))
        .routes(routes!(files::move_entry))
        .routes(routes!(files::delete_entry))
        .routes(routes!(files::start_upload))
        .routes(routes!(files::upload_status, files::cancel_upload))
        .routes(routes!(files::finish_upload))
        .routes(routes!(git::status))
        .routes(routes!(terminal::terminals, terminal::open_terminal))
        .routes(routes!(terminal::close_terminal))
        .routes(routes!(push::push_state))
        .routes(routes!(push::subscribe, push::unsubscribe))
        .routes(routes!(push::test_push))
        // Saving text takes a larger body than the rest; within, its limit is what holds.
        .merge(
            OpenApiRouter::new()
                .routes(routes!(files::text, files::save_text))
                .layer(DefaultBodyLimit::max(MAX_SAVE_BYTES)),
        )
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
}

/// Upload chunks, which take larger bodies than the rest of the API.
pub(crate) fn uploads() -> Router<App> {
    Router::new()
        .route("/api/files/uploads/{id}/chunk", put(files::upload_chunk))
        .layer(DefaultBodyLimit::max(crate::files::MAX_CHUNK_BYTES))
}

/// The terminals' WebSockets.
pub(crate) fn sockets() -> Router<App> {
    Router::new().route("/api/terminals/{id}/socket", get(terminal::socket))
}

/// The API's OpenAPI document.
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    routes().split_for_parts().1
}
