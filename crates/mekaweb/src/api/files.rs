//! Files' endpoints. A file's contents come raw from `/api/files/raw`, which keeps a browser from
//! running any of it: everything is sandboxed and unsniffed, and only types a browser shows
//! without running anything (pictures, sound, video, PDFs, plain text) are shown in place rather
//! than downloaded. HTML and SVG in particular never run on mekaweb's address, where a script
//! would reach the terminal. `/api/files/watch` tells of changes to a folder as they happen.

use std::{convert::Infallible, time::Duration};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use serde::Deserialize;
use tokio::{io::AsyncReadExt, sync::mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use utoipa::{IntoParams, ToSchema};

use crate::{
    app::App,
    auth::Signed,
    error::{ApiError, ApiResult},
    files::{
        Entry, FilesError, Listing, Range, Text, UploadView, parse_range, range_reader, resolve,
        watch::Watching,
    },
};

/// How long a folder's changes are gathered before they are told, so a file written in several
/// steps is told once.
const GATHER: Duration = Duration::from_millis(250);

/// The least time between two changes told, so a folder changing all the time is not listed all
/// the time.
const SPACING: Duration = Duration::from_secs(1);

/// How often an idle change stream sends a comment, so proxies keep it open.
const KEEP_ALIVE: Duration = Duration::from_secs(25);

/// What a raw file is sent with when it is shown in place: content types a browser displays
/// without running anything.
const SHOWN_IN_PLACE: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "application/pdf",
];

/// A file or folder, by its absolute path or one starting with `~`.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct Location {
    pub(crate) path: String,
}

/// A folder to download as a zip, or entries chosen in one.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct ZipQuery {
    /// The folder, for all it holds.
    pub(crate) path: Option<String>,
    /// The id `POST /api/files/zip/selection` gave the entries chosen, for just those.
    pub(crate) selection: Option<String>,
}

/// Entries chosen in a folder, to download as one zip.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewSelection {
    /// The folder they are in.
    pub(crate) path: String,
    /// Their names in it.
    pub(crate) names: Vec<String>,
}

/// The id a selection's zip downloads by.
#[derive(Debug, serde::Serialize, ToSchema)]
pub(crate) struct SelectionMade {
    pub(crate) id: String,
}

/// A file to download or show.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct RawQuery {
    pub(crate) path: String,
    /// Download it, whatever it is.
    #[serde(default)]
    pub(crate) download: bool,
}

/// A new folder.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewFolder {
    /// Where to make it.
    pub(crate) path: String,
    /// Whether to make any folders above it that are missing too.
    #[serde(default)]
    pub(crate) parents: bool,
}

/// Where a folder was made.
#[derive(Debug, serde::Serialize, ToSchema)]
pub(crate) struct Made {
    /// Its absolute path.
    pub(crate) path: String,
    pub(crate) entry: Entry,
}

/// A move or rename.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct Move {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// An entry to delete.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct Target {
    pub(crate) path: String,
}

/// An upload to start.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewUpload {
    /// The folder it goes into.
    pub(crate) dir: String,
    pub(crate) name: String,
    /// Its size in bytes.
    pub(crate) size: u64,
    /// Whether it may replace a file of the same name, when it finishes.
    #[serde(default)]
    pub(crate) replace: bool,
}

/// Where a piece of an upload goes.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct ChunkQuery {
    /// Where in the file the piece starts: where the upload stands.
    pub(crate) offset: u64,
}

/// Finishing an upload.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub(crate) struct FinishUpload {
    /// Whether to replace a file of the same name.
    #[serde(default)]
    pub(crate) replace: bool,
}

fn path(path: &str) -> Result<std::path::PathBuf, ApiError> {
    Ok(resolve(path)?)
}

#[utoipa::path(
    get,
    path = "/api/files/list",
    tag = "files",
    params(Location),
    responses((status = 200, body = Listing), (status = 404, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn list(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<Location>,
) -> ApiResult<Json<Listing>> {
    Ok(Json(app.files.list(path(&query.path)?).await?))
}

/// Changes to a folder, as an event stream: a `change` event whenever what it holds may have
/// changed, at most about once a second, after which it is to be listed again. Events missed while
/// the stream was not open are not told, so a folder is listed again on reconnecting.
#[utoipa::path(
    get,
    path = "/api/files/watch",
    tag = "files",
    params(Location),
    responses((status = 200, description = "`change` events", content_type = "text/event-stream"), (status = 404, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn watch(
    State(app): State<App>,
    signed: Signed,
    Query(query): Query<Location>,
) -> ApiResult<Response> {
    let mut watching = app.files.watch(path(&query.path)?).await?;
    let (sender, receiver) = mpsc::channel::<Result<Event, Infallible>>(4);
    let device = signed.session.id;
    tokio::spawn(async move {
        tokio::select! {
            () = tell_changes(&mut watching, &sender) => {}
            () = app.auth.until_ended(&device) => {}
            () = sender.closed() => {}
        }
    });
    let stream =
        Sse::new(ReceiverStream::new(receiver)).keep_alive(KeepAlive::new().interval(KEEP_ALIVE));
    // Proxies that buffer, such as nginx, are told not to.
    Ok(([("x-accel-buffering", "no")], stream).into_response())
}

/// Sends a `change` event for each burst of changes to the folder `watching` follows.
async fn tell_changes(watching: &mut Watching, sender: &mpsc::Sender<Result<Event, Infallible>>) {
    loop {
        if watching.changes.changed().await.is_err() {
            return;
        }
        tokio::time::sleep(GATHER).await;
        watching.changes.mark_unchanged();
        let change = Event::default().event("change").data("");
        if sender.send(Ok(change)).await.is_err() {
            return;
        }
        tokio::time::sleep(SPACING).await;
    }
}

#[utoipa::path(
    get,
    path = "/api/files/text",
    tag = "files",
    params(Location),
    responses((status = 200, body = Text), (status = 404, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn text(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<Location>,
) -> ApiResult<Json<Text>> {
    Ok(Json(app.files.text(path(&query.path)?).await?))
}

#[utoipa::path(
    get,
    path = "/api/files/raw",
    tag = "files",
    params(RawQuery),
    responses(
        (status = 200, description = "The file", content_type = "application/octet-stream"),
        (status = 206, description = "The part of the file the `Range` asked for"),
        (status = 404, body = crate::error::Problem),
        (status = 416, description = "The `Range` is outside the file")
    , (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn raw(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<RawQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let download = app.files.open_file(path(&query.path)?).await?;
    let mime = mime_guess::from_path(&download.name).first_or_octet_stream();
    let essence = mime.essence_str().to_owned();
    let in_place = !query.download
        && (SHOWN_IN_PLACE.contains(&essence.as_str())
            || essence.starts_with("audio/")
            || essence.starts_with("video/")
            || essence == "text/plain");
    // SVG may show in an `<img>`, which runs nothing; opened directly it downloads.
    let content_type = if in_place || essence == "image/svg+xml" {
        if essence == "text/plain" {
            "text/plain; charset=utf-8".to_owned()
        } else {
            essence.clone()
        }
    } else {
        "application/octet-stream".to_owned()
    };
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if in_place { "inline" } else { "attachment" },
        encode_filename(&download.name)
    );
    let size = download.size;
    let last_modified = download
        .modified
        .map(|modified| modified.format("%a, %d %b %Y %H:%M:%S GMT").to_string());
    let etag = download.modified.map(|modified| {
        format!(
            "\"{:x}-{size:x}\"",
            modified.timestamp_nanos_opt().unwrap_or_default()
        )
    });
    // A range of a file that changed since the browser read the rest would mix two versions.
    let unchanged = headers
        .get(header::IF_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|validator| {
            let validator = validator.trim();
            Some(validator) == etag.as_deref() || Some(validator) == last_modified.as_deref()
        });
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|_| unchanged)
        .map_or(Range::Whole, |value| parse_range(value, size));
    let mut response_headers = HeaderMap::new();
    let insert = |headers: &mut HeaderMap, name: header::HeaderName, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    };
    insert(&mut response_headers, header::CONTENT_TYPE, &content_type);
    insert(
        &mut response_headers,
        header::CONTENT_DISPOSITION,
        &disposition,
    );
    insert(&mut response_headers, header::ACCEPT_RANGES, "bytes");
    insert(
        &mut response_headers,
        header::CACHE_CONTROL,
        "private, no-cache",
    );
    insert(
        &mut response_headers,
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff",
    );
    // Chrome refuses to show a sandboxed PDF; its viewer runs apart from the page anyway.
    if essence != "application/pdf" {
        insert(
            &mut response_headers,
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        );
    }
    if let Some(last_modified) = &last_modified {
        insert(&mut response_headers, header::LAST_MODIFIED, last_modified);
    }
    if let Some(etag) = &etag {
        insert(&mut response_headers, header::ETAG, etag);
    }
    match range {
        Range::Part { start, length } => {
            let reader =
                tokio::task::spawn_blocking(move || range_reader(download.file, start, length))
                    .await
                    .map_err(|error| ApiError::internal(&anyhow::anyhow!("{error}")))?
                    .map_err(|error| ApiError::from(FilesError::io(error, "the file")))?;
            insert(
                &mut response_headers,
                header::CONTENT_RANGE,
                &format!("bytes {start}-{}/{size}", start + length - 1),
            );
            insert(
                &mut response_headers,
                header::CONTENT_LENGTH,
                &length.to_string(),
            );
            let body = Body::from_stream(blocking_stream(reader));
            Ok((StatusCode::PARTIAL_CONTENT, response_headers, body).into_response())
        }
        Range::Unsatisfiable => {
            insert(
                &mut response_headers,
                header::CONTENT_RANGE,
                &format!("bytes */{size}"),
            );
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, response_headers).into_response())
        }
        Range::Whole => {
            let file = tokio::fs::File::from_std(download.file);
            // A file that says it is empty, as those in /proc and /sys do, is sent to its end
            // with no length; any other is sent as long as it said it was, even if it grows.
            let body = if size == 0 {
                Body::from_stream(ReaderStream::new(file))
            } else {
                insert(
                    &mut response_headers,
                    header::CONTENT_LENGTH,
                    &size.to_string(),
                );
                Body::from_stream(ReaderStream::new(file.take(size)))
            };
            Ok((StatusCode::OK, response_headers, body).into_response())
        }
    }
}

/// What `reader` reads, read on a blocking thread, as a stream.
fn blocking_stream(
    reader: impl std::io::Read + Send + 'static,
) -> ReceiverStream<std::io::Result<Bytes>> {
    let (sender, receiver) = mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = Bytes::copy_from_slice(buffer.get(..read).unwrap_or_default());
                    if sender.blocking_send(Ok(chunk)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    if let Err(error) = sender.blocking_send(Err(error)) {
                        tracing::debug!("a download stopped: {error}");
                    }
                    break;
                }
            }
        }
    });
    ReceiverStream::new(receiver)
}

/// `name` percent-encoded for `filename*=`.
fn encode_filename(name: &str) -> String {
    name.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

#[utoipa::path(
    get,
    path = "/api/files/zip",
    tag = "files",
    params(ZipQuery),
    responses((status = 200, description = "The folder as a zip", content_type = "application/zip"), (status = 404, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn zip(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<ZipQuery>,
) -> ApiResult<Response> {
    let (folder, only) = match (query.selection, query.path) {
        (Some(id), _) => {
            let selection = app.files.selection(&id)?;
            (selection.folder, Some(selection.names))
        }
        (None, Some(folder)) => (path(&folder)?, None),
        (None, None) => {
            return Err(FilesError::BadPath("give a folder or a selection".to_owned()).into());
        }
    };
    let dir = app.files.open_folder(folder.clone()).await?;
    let name = folder.file_name().map_or_else(
        || "root".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let (sender, receiver) = mpsc::channel(8);
    let prefix = name.clone();
    tokio::task::spawn_blocking(move || crate::files::zip::write(dir, prefix, only, sender));
    let disposition = format!(
        "attachment; filename*=UTF-8''{}",
        encode_filename(&format!("{name}.zip"))
    );
    let mut response = Response::new(Body::from_stream(ReceiverStream::new(receiver)));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

/// Keeps entries chosen in a folder for a zip of them, which `GET /api/files/zip` then downloads
/// by the id given: their names would make too long an address.
#[utoipa::path(
    post,
    path = "/api/files/zip/selection",
    tag = "files",
    request_body = NewSelection,
    responses((status = 200, body = SelectionMade), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn select_for_zip(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<NewSelection>,
) -> ApiResult<Json<SelectionMade>> {
    let folder = path(&body.path)?;
    let id = app.files.select(folder, body.names)?;
    Ok(Json(SelectionMade { id }))
}

#[utoipa::path(
    post,
    path = "/api/files/folders",
    tag = "files",
    request_body = NewFolder,
    responses((status = 200, body = Made), (status = 409, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn make_folder(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<NewFolder>,
) -> ApiResult<Json<Made>> {
    let folder = path(&body.path)?;
    let entry = app.files.make_folder(folder.clone(), body.parents).await?;
    Ok(Json(Made {
        path: folder.display().to_string(),
        entry,
    }))
}

#[utoipa::path(
    post,
    path = "/api/files/move",
    tag = "files",
    request_body = Move,
    responses((status = 204), (status = 409, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn move_entry(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<Move>,
) -> ApiResult<StatusCode> {
    app.files
        .move_entry(path(&body.from)?, path(&body.to)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/files/delete",
    tag = "files",
    request_body = Target,
    responses((status = 204), (status = 404, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn delete_entry(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<Target>,
) -> ApiResult<StatusCode> {
    app.files.delete(path(&body.path)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/files/uploads",
    tag = "files",
    request_body = NewUpload,
    responses((status = 200, body = UploadView), (status = 409, description = "A file of that name is there", body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn start_upload(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<NewUpload>,
) -> ApiResult<Json<UploadView>> {
    Ok(Json(
        app.files
            .start_upload(path(&body.dir)?, &body.name, body.size, body.replace)
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/files/uploads/{id}",
    tag = "files",
    params(("id" = String, Path)),
    responses((status = 200, body = UploadView), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn upload_status(
    State(app): State<App>,
    _signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Json<UploadView>> {
    Ok(Json(app.files.upload_status(&id).await?))
}

/// Writes a piece of an upload: `PUT /api/files/uploads/{id}/chunk?offset=…` with the bytes as
/// the body, at most [`crate::files::MAX_CHUNK_BYTES`]. A piece that does not start where the
/// upload stands is refused with 409, and the upload's state says where to go on from.
pub(crate) async fn upload_chunk(
    State(app): State<App>,
    _signed: Signed,
    Path(id): Path<String>,
    Query(query): Query<ChunkQuery>,
    body: Bytes,
) -> ApiResult<Json<UploadView>> {
    Ok(Json(app.files.write_chunk(&id, query.offset, body).await?))
}

#[utoipa::path(
    post,
    path = "/api/files/uploads/{id}/finish",
    tag = "files",
    params(("id" = String, Path)),
    request_body = FinishUpload,
    responses((status = 200, body = Entry), (status = 409, body = crate::error::Problem), (status = 400, body = crate::error::Problem), (status = 403, body = crate::error::Problem))
)]
pub(crate) async fn finish_upload(
    State(app): State<App>,
    _signed: Signed,
    Path(id): Path<String>,
    Json(body): Json<FinishUpload>,
) -> ApiResult<Json<Entry>> {
    Ok(Json(app.files.finish_upload(&id, body.replace).await?))
}

#[utoipa::path(
    delete,
    path = "/api/files/uploads/{id}",
    tag = "files",
    params(("id" = String, Path)),
    responses((status = 204), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn cancel_upload(
    State(app): State<App>,
    _signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    app.files.cancel_upload(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
