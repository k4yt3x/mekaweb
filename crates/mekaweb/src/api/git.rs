//! git's endpoint: how a repository Files shows stands, to mark its entries and show its branch.

use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use utoipa::IntoParams;

use crate::{app::App, auth::Signed, error::ApiResult, files::resolve, git::GitStatus};

/// A repository, by its folder, as a listing names it.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct Repository {
    pub(crate) repo: String,
}

/// How the repository whose folder is `repo` stands: its branch, and the entries changed, new or
/// ignored since its last commit. Read again for each request, by running git, which runs no
/// program the repository's own config names.
#[utoipa::path(
    get,
    path = "/api/git/status",
    tag = "git",
    params(Repository),
    responses((status = 200, body = GitStatus), (status = 400, body = crate::error::Problem), (status = 404, body = crate::error::Problem), (status = 422, body = crate::error::Problem))
)]
pub(crate) async fn status(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<Repository>,
) -> ApiResult<Json<GitStatus>> {
    let repo = resolve(&query.repo)?;
    Ok(Json(GitStatus::clone(&*app.git.status(repo).await?)))
}
