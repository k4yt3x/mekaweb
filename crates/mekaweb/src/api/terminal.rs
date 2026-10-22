//! Terminals' endpoints. Signing in is all a terminal needs: whoever is signed in can run
//! anything through meka's agent already.
//!
//! The WebSocket carries the shell's output as binary messages, and the browser's input and
//! resizes as JSON text messages: `{"type":"input","data":"…"}` and
//! `{"type":"resize","cols":80,"rows":24}`. When the shell ends the server sends
//! `{"type":"exit","code":0}` and closes.

use std::{path::PathBuf, sync::Arc};

use axum::{
    Json,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    app::{App, is_same_origin},
    auth::Signed,
    error::{ApiError, ApiResult},
    terminal::{Attachment, Output, TerminalView},
};

/// A terminal to open.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewTerminal {
    /// The folder to start in; the home folder unless given.
    pub(crate) cwd: Option<String>,
    /// The meka session it belongs to, if any: it is found by it, and closes with it. A session
    /// whose terminal is open gets that one.
    pub(crate) session: Option<String>,
    #[serde(default = "default_cols")]
    pub(crate) cols: u16,
    #[serde(default = "default_rows")]
    pub(crate) rows: u16,
}

/// The largest message a terminal's connection takes: a long paste, not a file.
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// How often a terminal's connection is pinged, well within idle limits such as Cloudflare's
/// 100 seconds.
const KEEP_ALIVE: std::time::Duration = std::time::Duration::from_secs(30);

const fn default_cols() -> u16 {
    80
}

const fn default_rows() -> u16 {
    24
}

/// What the browser sends on a terminal's WebSocket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Incoming {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

fn disabled() -> ApiError {
    ApiError::disabled("terminals are turned off in mekaweb's config")
}

/// Which terminals to list.
#[derive(Debug, Deserialize, IntoParams)]
pub(crate) struct TerminalQuery {
    /// Only those of this meka session.
    pub(crate) session: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/terminals",
    tag = "terminal",
    params(TerminalQuery),
    responses(
        (status = 200, body = Vec<TerminalView>),
        (status = 404, description = "Terminals are turned off", body = crate::error::Problem)
    )
)]
pub(crate) async fn terminals(
    State(app): State<App>,
    _signed: Signed,
    Query(query): Query<TerminalQuery>,
) -> ApiResult<Json<Vec<TerminalView>>> {
    if !app.terminals.is_enabled() {
        return Err(disabled());
    }
    Ok(Json(app.terminals.list(query.session.as_deref())))
}

#[utoipa::path(
    post,
    path = "/api/terminals",
    tag = "terminal",
    request_body = NewTerminal,
    responses(
        (status = 200, body = TerminalView),
        (status = 400, description = "The folder is not one, or too many terminals are open", body = crate::error::Problem),
        (status = 404, description = "Terminals are turned off", body = crate::error::Problem)
    )
)]
pub(crate) async fn open_terminal(
    State(app): State<App>,
    _signed: Signed,
    Json(body): Json<NewTerminal>,
) -> ApiResult<Json<TerminalView>> {
    if !app.terminals.is_enabled() {
        return Err(disabled());
    }
    // A folder as Files takes one: absolute, or from home with `~`.
    let cwd = match body.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => {
            crate::files::resolve(cwd).map_err(|error| ApiError::bad_request(error.to_string()))?
        }
        None => crate::config::home().unwrap_or_else(|_| PathBuf::from("/")),
    };
    let session = body
        .session
        .map(|session| session.trim().to_owned())
        .filter(|session| !session.is_empty());
    let view = app
        .terminals
        .open(&cwd, body.cols, body.rows, session)
        .map_err(|error| ApiError::bad_request(format!("{error:#}")))?;
    Ok(Json(view))
}

#[utoipa::path(
    delete,
    path = "/api/terminals/{id}",
    tag = "terminal",
    params(("id" = String, Path)),
    responses((status = 204), (status = 404, body = crate::error::Problem))
)]
pub(crate) async fn close_terminal(
    State(app): State<App>,
    _signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if app.terminals.close(&id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("there is no such terminal"))
    }
}

/// Attaches to a terminal over a WebSocket.
pub(crate) async fn socket(
    State(app): State<App>,
    signed: Signed,
    Path(id): Path<String>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // A cookie goes with a WebSocket from any page; only mekaweb's own may open one.
    if !is_same_origin(&app, &headers) {
        return ApiError::forbidden_origin().into_response();
    }
    if !app.terminals.is_enabled() {
        return disabled().into_response();
    }
    let Some(attachment) = app.terminals.attach(&id) else {
        return ApiError::not_found("there is no such terminal").into_response();
    };
    let device = signed.session.id;
    upgrade
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| relay(app, socket, attachment, device))
        .into_response()
}

/// Carries a terminal's output to the browser and the browser's input to it, until either ends
/// or the device is signed out. Input is written apart from output, so a shell that stops reading
/// holds up neither its output nor the end of the connection.
async fn relay(app: App, socket: WebSocket, mut attachment: Attachment, device: String) {
    let (mut sender, mut receiver) = socket.split();
    if !attachment.replay.is_empty()
        && sender
            .send(Message::Binary(
                std::mem::take(&mut attachment.replay).into(),
            ))
            .await
            .is_err()
    {
        return;
    }
    if let Some(code) = attachment.exited {
        if let Err(error) = sender.send(exit_message(code)).await {
            tracing::debug!("the terminal's connection closed: {error}");
        }
        return;
    }
    let terminal = Arc::clone(&attachment.terminal);
    let input = async move {
        while let Some(message) = receiver.next().await {
            let written = match message {
                Ok(Message::Text(text)) => match serde_json::from_str::<Incoming>(&text) {
                    Ok(Incoming::Input { data }) => terminal.input(data.as_bytes()).await,
                    Ok(Incoming::Resize { cols, rows }) => {
                        if let Err(error) = terminal.resize(cols, rows).await {
                            tracing::debug!("could not resize the terminal: {error:#}");
                        }
                        Ok(())
                    }
                    Err(error) => {
                        tracing::debug!("an unreadable terminal message: {error}");
                        Ok(())
                    }
                },
                Ok(Message::Binary(data)) => terminal.input(&data).await,
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => Ok(()),
            };
            if let Err(error) = written {
                tracing::debug!("could not write to the terminal: {error}");
                break;
            }
        }
    };
    let output = async {
        // Traffic on a terminal nobody is using keeps proxies, Cloudflare's included, from
        // closing the connection as idle.
        let mut keep_alive = tokio::time::interval(KEEP_ALIVE);
        keep_alive.tick().await;
        loop {
            tokio::select! {
                _ = keep_alive.tick() => {
                    if sender.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
                output = attachment.output.recv() => match output {
                    Ok(Output::Data(data)) => {
                        if sender.send(Message::Binary(data)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Output::Exit(code)) => {
                        if let Err(error) = sender.send(exit_message(code)).await {
                            tracing::debug!("the terminal's connection closed: {error}");
                        }
                        break;
                    }
                    // Too far behind: the browser reconnects and replays.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        close(&mut sender, 4000, "fell behind").await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                () = app.auth.until_ended(&device) => {
                    close(&mut sender, 4001, "signed out").await;
                    break;
                }
            }
        }
    };
    tokio::select! {
        () = input => {}
        () = output => {}
    }
}

fn exit_message(code: Option<i32>) -> Message {
    Message::Text(
        serde_json::json!({ "type": "exit", "code": code })
            .to_string()
            .into(),
    )
}

async fn close(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: u16,
    reason: &'static str,
) {
    let frame = CloseFrame {
        code,
        reason: reason.into(),
    };
    if let Err(error) = sender.send(Message::Close(Some(frame))).await {
        tracing::debug!("could not close a terminal's connection: {error}");
    }
}
