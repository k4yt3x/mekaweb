//! The server: everything a request may need, the routes, and the checks every request passes.

use std::{net::SocketAddr, ops::Deref, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{Request, State},
    http::{Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use chrono::Utc;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::{CompressionLayer, predicate::Predicate},
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
};

use crate::{
    api,
    auth::{ABSOLUTE_LIFETIME, Auth, IDLE_LIFETIME},
    config::Config,
    error::ApiError,
    files::Files,
    meka::Meka,
    proxy::{self, Watching},
    push::Push,
    store::Store,
    terminal::Terminals,
    web::{self, SecurityHeaders},
};

/// The largest request body meka takes, and so the largest passed to it.
pub(crate) const MAX_MEKA_BODY_BYTES: usize = 10 * 1024 * 1024;

/// How often expired sign-ins and abandoned uploads are cleared away.
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

/// Everything a request may need.
pub(crate) struct AppInner {
    pub(crate) config: Config,
    pub(crate) store: Store,
    pub(crate) auth: Auth,
    pub(crate) meka: Arc<Meka>,
    pub(crate) watching: Arc<Watching>,
    pub(crate) files: Files,
    pub(crate) terminals: Arc<Terminals>,
    pub(crate) push: Arc<Push>,
}

/// The server's state, shared by every request.
#[derive(Clone)]
pub(crate) struct App(Arc<AppInner>);

impl Deref for App {
    type Target = AppInner;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl App {
    /// The server for `config`, keeping its state in `store`.
    pub(crate) async fn open(config: Config, store: Store) -> anyhow::Result<Self> {
        let auth = Auth::new(&config, store.clone())?;
        auth.hasher().prepare().await?;
        let meka = Meka::new(&config)?;
        let watching = Arc::new(Watching::default());
        let files = Files::new(store.clone());
        let terminals = Terminals::new(&config.terminal);
        let push = Push::open(
            &config,
            store.clone(),
            Arc::clone(&meka),
            Arc::clone(&watching),
            Arc::clone(&terminals),
        )
        .await?;
        Ok(Self(Arc::new(AppInner {
            config,
            store,
            auth,
            meka,
            watching,
            files,
            terminals,
            push,
        })))
    }

    /// Starts the work that runs alongside requests: checking meka, sending push notifications,
    /// closing idle terminals, and clearing away what has expired.
    pub(crate) fn start(&self) {
        tokio::spawn(Arc::clone(&self.meka).watch());
        tokio::spawn(Arc::clone(&self.push).follow());
        tokio::spawn(Arc::clone(&self.terminals).reap());
        let app = self.clone();
        tokio::spawn(async move {
            loop {
                app.sweep().await;
                tokio::time::sleep(SWEEP_EVERY).await;
            }
        });
    }

    async fn sweep(&self) {
        let now = Utc::now();
        let unused_since = now - chrono::Duration::from_std(IDLE_LIFETIME).unwrap_or_default();
        let created_before =
            now - chrono::Duration::from_std(ABSOLUTE_LIFETIME).unwrap_or_default();
        match self
            .store
            .delete_expired_sessions(unused_since, created_before)
            .await
        {
            Ok(0) => {}
            Ok(count) => {
                tracing::info!("{count} expired sign-ins ended");
                self.auth.sessions_ended();
            }
            Err(error) => tracing::error!("could not end expired sign-ins: {error:#}"),
        }
        if let Err(error) = self.files.sweep_uploads().await {
            tracing::error!("could not clear abandoned uploads: {error:#}");
        }
    }
}

/// The routes, with the checks every request passes.
pub(crate) fn router(app: &App) -> anyhow::Result<Router> {
    let headers = SecurityHeaders::new(&app.config.public_origin)?;
    let (api, _) = api::routes().split_for_parts();
    let api = api
        .merge(api::uploads())
        .merge(api::sockets())
        .layer(CompressionLayer::new().compress_when(JsonAndText));
    // The proxy streams bodies on rather than extracting them, so their size is held by a layer.
    let meka = Router::new()
        .route("/meka/{*rest}", any(proxy::forward))
        .layer(RequestBodyLimitLayer::new(MAX_MEKA_BODY_BYTES))
        .layer(CompressionLayer::new().compress_when(JsonAndText));
    Ok(Router::new()
        .merge(api)
        .merge(meka)
        .fallback(web::serve)
        .layer(middleware::from_fn_with_state(app.clone(), check_origin))
        // Inside the security headers, so the answer to a panic carries them too.
        .layer(CatchPanicLayer::new())
        .layer(middleware::from_fn_with_state(
            headers,
            web::security_headers,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(app.clone()))
}

/// Compresses JSON and plain text, which is everything the API answers but downloads, files and
/// event streams.
#[derive(Clone, Copy)]
struct JsonAndText;

impl Predicate for JsonAndText {
    fn should_compress<B>(&self, response: &axum::http::Response<B>) -> bool
    where
        B: axum::body::HttpBody,
    {
        let headers = response.headers();
        let kind = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        !headers.contains_key(header::CONTENT_RANGE)
            && !headers.contains_key(header::CONTENT_DISPOSITION)
            && (kind.starts_with("application/json")
                || kind.starts_with("application/problem+json")
                || kind.starts_with("text/plain"))
    }
}

/// Refuses a write to the API or to meka that did not come from mekaweb's own pages: its `Origin`
/// must be `public_origin`, or, without one, the browser must say it is same-origin. A cookie set
/// `SameSite=Strict` is not sent from elsewhere anyway; this holds even where it would be.
async fn check_origin(State(app): State<App>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let guarded = path.starts_with("/api/") || path.starts_with("/meka/");
    let safe = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if guarded && !safe && !is_same_origin(&app, request.headers()) {
        return ApiError::forbidden_origin().into_response();
    }
    next.run(request).await
}

/// Whether a request says it comes from mekaweb's own pages. An `Origin` that is there but cannot
/// be read is not believed to be one.
pub(crate) fn is_same_origin(app: &App, headers: &axum::http::HeaderMap) -> bool {
    match headers.get(header::ORIGIN) {
        Some(origin) => origin
            .to_str()
            .is_ok_and(|origin| origin.trim_end_matches('/') == app.config.origin()),
        None => headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|site| site == "same-origin"),
    }
}

/// Serves `app` until the process is told to stop.
pub(crate) async fn serve(app: App) -> anyhow::Result<()> {
    let router = router(&app)?;
    let listener = tokio::net::TcpListener::bind(app.config.listen).await?;
    tracing::info!(
        "mekaweb {} listens on {}, for {}",
        env!("CARGO_PKG_VERSION"),
        app.config.listen,
        app.config.origin()
    );
    if !web::is_built() {
        tracing::warn!("the web interface was not built into this binary; only the API answers");
    }
    app.start();
    let stopped = Arc::new(tokio::sync::Notify::new());
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown({
        let app = app.clone();
        let stopped = Arc::clone(&stopped);
        async move {
            shutdown().await;
            // Event streams and terminals end now, rather than holding the stop up.
            app.auth.stop();
            stopped.notify_one();
        }
    });
    // A connection that will not finish is not waited for long.
    tokio::select! {
        result = server => result?,
        () = async {
            stopped.notified().await;
            tokio::time::sleep(STOP_GRACE).await;
        } => tracing::warn!("connections still open after {STOP_GRACE:?}; stopping anyway"),
    }
    app.terminals.close_all().await;
    Ok(())
}

/// How long connections have to finish once mekaweb is told to stop.
const STOP_GRACE: Duration = Duration::from_secs(10);

async fn shutdown() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!("could not listen for SIGTERM: {error}");
                std::future::pending::<()>().await;
            }
        }
    };
    // Windows closing the console mekaweb runs in, or shutting down.
    #[cfg(windows)]
    let terminate = async {
        let (Ok(mut close), Ok(mut shutdown)) = (
            tokio::signal::windows::ctrl_close(),
            tokio::signal::windows::ctrl_shutdown(),
        ) else {
            tracing::error!("could not listen for the console closing");
            return std::future::pending::<()>().await;
        };
        tokio::select! {
            _ = close.recv() => {}
            _ = shutdown.recv() => {}
        }
    };
    tokio::select! {
        result = interrupt => {
            if let Err(error) = result {
                tracing::error!("could not listen for Ctrl-C: {error}");
            }
        }
        () = terminate => {}
    }
    tracing::info!("stopping");
}
