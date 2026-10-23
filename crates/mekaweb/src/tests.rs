//! In-process tests of the API, against a stand-in meka on a local port.

use std::{
    io::Read,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use tower::ServiceExt;

use crate::{
    app::{App, router},
    auth::password::Hasher,
    config::Config,
    store::Store,
};

const ORIGIN: &str = "http://localhost:4180";
const TOKEN: &str = "meka-test-token";
const PASSWORD: &str = "correct horse battery";

/// What the stand-in meka saw of the last request to `/v1/echo`.
#[derive(Debug, Default, Clone)]
struct Seen {
    headers: Vec<(String, String)>,
}

/// A stand-in meka: `/v1/info`, `/v1/echo` and a session's event stream.
async fn stand_in_meka() -> (SocketAddr, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = Router::new()
        .route(
            "/v1/info",
            get(|headers: HeaderMap| async move {
                if headers
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    != Some(&format!("Bearer {TOKEN}"))
                {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Json(serde_json::json!({
                    "version": "0.83.0",
                    "scopes": ["sessions:r", "sessions:w"],
                    "default_permission": "workspace",
                    "enabled_permissions": ["read", "workspace"],
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/echo",
            any(
                |State(seen): State<Arc<Mutex<Seen>>>, headers: HeaderMap| async move {
                    let mut recorded: Vec<(String, String)> = headers
                        .iter()
                        .map(|(name, value)| {
                            (
                                name.to_string(),
                                value.to_str().unwrap_or_default().to_owned(),
                            )
                        })
                        .collect();
                    recorded.sort();
                    *seen.lock().unwrap() = Seen { headers: recorded };
                    Json(serde_json::json!({ "ok": true }))
                },
            ),
        )
        .route(
            "/v1/sessions/s1/stream",
            get(|| async {
                let old = (1..=50).map(|n| format!("line {n}\n")).collect::<String>();
                let new = old.replace("line 25\n", "line twenty-five\n");
                let completed = serde_json::json!({
                    "id": "toolu_1",
                    "is_error": false,
                    "content": [{"type": "text", "text": "Edited"}],
                    "change": {"path": "a.txt", "old": old, "new": new},
                });
                let first = format!("id: 1\nevent: tool_call.completed\ndata: {completed}\n\n");
                let stream = futures_util::stream::iter([Ok::<_, std::io::Error>(first)])
                    .chain(futures_util::stream::pending());
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        )
        .route(
            "/v1/unauthorized",
            get(|| async { StatusCode::UNAUTHORIZED }),
        )
        // Anything else answers with the path and query it came to, as written.
        .fallback(|uri: axum::http::Uri, body: Body| async move {
            let bytes = body.collect().await.map_or(0, |body| body.to_bytes().len());
            Json(serde_json::json!({
                "path": uri.path(),
                "query": uri.query(),
                "bytes": bytes,
            }))
        })
        .with_state(Arc::clone(&seen));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, seen)
}

/// mekaweb in front of the stand-in meka, with the user added, and its temporary folder.
async fn mekaweb() -> (App, Router, Arc<Mutex<Seen>>, tempfile::TempDir) {
    let (meka, seen) = stand_in_meka().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("token"), TOKEN).unwrap();
    std::fs::create_dir_all(dir.path().join("work")).unwrap();
    let config = Config::parse(&format!(
        "listen = \"127.0.0.1:0\"\npublic_origin = \"{ORIGIN}\"\nstate_dir = '{0}/state'\n[meka]\nurl = \"http://{meka}\"\ntoken_file = '{0}/token'\n[push]\nsubject = \"mailto:me@example.com\"\n",
        dir.path().display()
    ))
    .unwrap();
    let store = Store::in_memory().unwrap();
    let hash = Hasher::new().unwrap().hash(PASSWORD).await.unwrap();
    store.add_user("me", &hash).await.unwrap();
    let app = App::open(config, store).await.unwrap();
    let router = router(&app).unwrap();
    (app, router, seen, dir)
}

fn request(method: &str, path: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
}

async fn send(router: &Router, request: Request<Body>) -> Response {
    router.clone().oneshot(request).await.unwrap()
}

async fn json(response: Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

/// Signs in, returning the `Cookie` header to send.
async fn sign_in(router: &Router) -> String {
    let response = send(
        router,
        request("POST", "/api/auth/password")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "username": "me", "password": PASSWORD }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"),
        "{cookie}"
    );
    cookie.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn signing_in_sets_a_cookie_that_signs_requests_in() {
    let (_app, router, _, _dir) = mekaweb().await;
    let unsigned = send(
        &router,
        request("GET", "/api/auth/session")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
    assert!(
        unsigned
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY),
        "every response carries the security headers"
    );
    let cookie = sign_in(&router).await;
    let response = send(
        &router,
        request("GET", "/api/auth/session")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let session = json(response).await;
    assert_eq!(session["username"], "me");
    assert_eq!(
        session["passkeys_available"], true,
        "localhost offers passkeys"
    );
    let out = send(
        &router,
        request("POST", "/api/auth/sign-out")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(out.status(), StatusCode::NO_CONTENT);
    let after = send(
        &router,
        request("GET", "/api/auth/session")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_write_from_another_site_is_refused() {
    let (_app, router, _, _dir) = mekaweb().await;
    let body =
        || Body::from(serde_json::json!({ "username": "me", "password": PASSWORD }).to_string());
    let elsewhere = Request::builder()
        .method("POST")
        .uri("/api/auth/password")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body())
        .unwrap();
    assert_eq!(
        send(&router, elsewhere).await.status(),
        StatusCode::FORBIDDEN
    );
    let unmarked = Request::builder()
        .method("POST")
        .uri("/api/auth/password")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body())
        .unwrap();
    assert_eq!(
        send(&router, unmarked).await.status(),
        StatusCode::FORBIDDEN
    );
    let same_origin = Request::builder()
        .method("POST")
        .uri("/api/auth/password")
        .header("sec-fetch-site", "same-origin")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body())
        .unwrap();
    assert_eq!(send(&router, same_origin).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn guessing_the_password_is_slowed() {
    let (_app, router, _, _dir) = mekaweb().await;
    let mut statuses = Vec::new();
    for _ in 0..12 {
        let response = send(
            &router,
            request("POST", "/api/auth/password")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "username": "me", "password": "wrong password" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await;
        statuses.push(response.status());
    }
    assert_eq!(statuses[0], StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(*statuses.last().unwrap(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn requests_to_meka_carry_its_token_and_not_the_browsers_credentials() {
    let (_app, router, seen, _dir) = mekaweb().await;
    let unsigned = send(
        &router,
        request("GET", "/meka/v1/echo").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
    let cookie = sign_in(&router).await;
    let response = send(
        &router,
        request("POST", "/meka/v1/echo?x=1")
            .header(header::COOKIE, &cookie)
            .header(header::AUTHORIZATION, "Bearer not-for-meka")
            .header("idempotency-key", "abc")
            .header("last-event-id", "7")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let seen = seen.lock().unwrap().clone();
    let header = |name: &str| {
        seen.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(
        header("authorization").as_deref(),
        Some("Bearer meka-test-token")
    );
    assert_eq!(header("cookie"), None);
    assert_eq!(header("idempotency-key").as_deref(), Some("abc"));
    assert_eq!(header("last-event-id").as_deref(), Some("7"));
    assert_eq!(header("origin"), None);
    let openapi = send(
        &router,
        request("GET", "/meka/v1/openapi.json")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(openapi.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_event_stream_arrives_compressed_with_its_change_as_a_diff_and_marks_its_watcher() {
    let (app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let devices = send(
        &router,
        request("GET", "/api/account/devices")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let device = json(devices).await[0]["id"].as_str().unwrap().to_owned();
    let response = send(
        &router,
        request("GET", "/meka/v1/sessions/s1/stream")
            .header(header::COOKIE, &cookie)
            .header(header::ACCEPT_ENCODING, "gzip, br")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_ENCODING).unwrap(),
        "gzip"
    );
    assert!(app.watching.is_watching(&device, "s1"));
    let mut body = response.into_body();
    let mut compressed = Vec::new();
    let mut text = String::new();
    // The first event comes on its own, though the stream stays open.
    while !text.contains("\n\n") {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            compressed.extend_from_slice(&data);
        }
        text.clear();
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut partial = Vec::new();
        // A stream cut mid-way reads up to where it stands, then errs.
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = decoder.read(&mut buffer) {
            if read == 0 {
                break;
            }
            partial.extend_from_slice(&buffer[..read]);
        }
        text = String::from_utf8_lossy(&partial).into_owned();
    }
    assert!(text.contains("-line 25\\n+line twenty-five\\n"), "{text}");
    assert!(!text.contains("\"old\""));
    drop(body);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!app.watching.is_watching(&device, "s1"));
}

#[tokio::test]
async fn risky_changes_need_a_recent_confirmation() {
    let (app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let challenge = || {
        request("POST", "/api/account/passkeys/challenge")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        send(&router, challenge()).await.status(),
        StatusCode::OK,
        "signing in confirms"
    );
    let user = app.store.user().await.unwrap().unwrap();
    let session = app.store.sessions(user.id).await.unwrap().remove(0);
    app.store
        .age_verification_for_test(&session.id)
        .await
        .unwrap();
    let refused = send(&router, challenge()).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json(refused).await["type"],
        "urn:mekaweb:verification-required"
    );
    let confirm = send(
        &router,
        request("POST", "/api/auth/confirm")
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "password": PASSWORD }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(confirm.status(), StatusCode::OK);
    assert_eq!(send(&router, challenge()).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn files_list_and_uploads_land_through_the_api() {
    let (_app, router, _, dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let work = dir.path().join("work");
    let encoded = |path: std::path::PathBuf| {
        percent_encoding::utf8_percent_encode(
            &path.display().to_string(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string()
    };
    let start = send(
        &router,
        request("POST", "/api/files/uploads")
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "dir": work, "name": "a.txt", "size": 5 }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(start.status(), StatusCode::OK);
    let id = json(start).await["id"].as_str().unwrap().to_owned();
    let chunk = send(
        &router,
        request("PUT", &format!("/api/files/uploads/{id}/chunk?offset=0"))
            .header(header::COOKIE, &cookie)
            .body(Body::from("hello"))
            .unwrap(),
    )
    .await;
    assert_eq!(chunk.status(), StatusCode::OK);
    let finish = send(
        &router,
        request("POST", &format!("/api/files/uploads/{id}/finish"))
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap(),
    )
    .await;
    assert_eq!(finish.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("work/a.txt")).unwrap(),
        "hello"
    );
    let raw = send(
        &router,
        request(
            "GET",
            &format!("/api/files/raw?path={}", encoded(work.join("a.txt"))),
        )
        .header(header::COOKIE, &cookie)
        .header(header::RANGE, "bytes=1-3")
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(raw.status(), StatusCode::PARTIAL_CONTENT);
    assert!(
        raw.headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("sandbox")
    );
    let bytes = raw.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ell");
    std::fs::write(
        dir.path().join("work/page.html"),
        "<script>alert(1)</script>",
    )
    .unwrap();
    let html = send(
        &router,
        request(
            "GET",
            &format!("/api/files/raw?path={}", encoded(work.join("page.html"))),
        )
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(
        html.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/octet-stream"
    );
    assert!(
        html.headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
    // Anywhere the user may read, by a path from home too.
    let listing = send(
        &router,
        request(
            "GET",
            &format!("/api/files/list?path={}", encoded(work.join("x/../."))),
        )
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(listing.status(), StatusCode::OK);
    let listing = json(listing).await;
    assert_eq!(listing["path"], work.display().to_string());
    assert_eq!(
        listing["home"],
        crate::files::resolve("~").unwrap().display().to_string()
    );
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["a.txt", "page.html"]);
    let relative = send(
        &router,
        request("GET", "/api/files/list?path=work")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(relative.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_folder_watched_tells_of_its_changes_until_the_sign_in_ends() {
    let (_app, router, _, dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let work = dir.path().join("work");
    let watch = |path: &std::path::Path| {
        let path = percent_encoding::utf8_percent_encode(
            &path.display().to_string(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        request("GET", &format!("/api/files/watch?path={path}"))
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap()
    };
    let missing = send(&router, watch(&work.join("missing"))).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let response = send(&router, watch(&work)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let mut body = response.into_body().into_data_stream();
    std::fs::write(work.join("new.txt"), "x").unwrap();
    let told = tokio::time::timeout(Duration::from_secs(10), async {
        let mut seen = String::new();
        while let Some(chunk) = body.next().await {
            seen.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if seen.contains("event: change") {
                break;
            }
        }
        seen
    })
    .await
    .unwrap();
    assert!(told.contains("event: change"), "{told:?}");
    let out = send(
        &router,
        request("POST", "/api/auth/sign-out")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(out.status(), StatusCode::NO_CONTENT);
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while body.next().await.is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "the stream ends with the sign-in");
}

#[tokio::test]
async fn entries_chosen_download_as_one_zip_by_the_id_kept_for_them() {
    let (_app, router, _, dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let work = dir.path().join("work");
    std::fs::write(work.join("a.txt"), "alpha").unwrap();
    std::fs::write(work.join("b.txt"), "beta").unwrap();
    std::fs::write(work.join("c.txt"), "gamma").unwrap();
    let select = |names: serde_json::Value| {
        request("POST", "/api/files/zip/selection")
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "path": work, "names": names }).to_string(),
            ))
            .unwrap()
    };
    let made = send(&router, select(serde_json::json!(["a.txt", "c.txt"]))).await;
    assert_eq!(made.status(), StatusCode::OK);
    let id = json(made).await["id"].as_str().unwrap().to_owned();
    let download = |query: String| {
        request("GET", &format!("/api/files/zip?{query}"))
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap()
    };
    let zip = send(&router, download(format!("selection={id}"))).await;
    assert_eq!(zip.status(), StatusCode::OK);
    let archive = zip.into_body().collect().await.unwrap().to_bytes();
    let archive = zip::ZipArchive::new(std::io::Cursor::new(archive.to_vec())).unwrap();
    let mut names: Vec<String> = archive
        .file_names()
        .map(|name| name.unwrap().into_owned())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["work/", "work/a.txt", "work/c.txt"]);
    // A name is one name, and an id is one given.
    let refused = send(&router, select(serde_json::json!(["../a.txt"]))).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    let unknown = send(&router, download("selection=nothing".to_owned())).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn paths_reach_meka_as_written_and_never_leave_its_api() {
    let (_app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let get = |path: &str| {
        request("GET", path)
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap()
    };
    let response = send(&router, get("/meka/v1/memory/a%2Fb%3Fc%25d?x=1")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let seen = json(response).await;
    assert_eq!(seen["path"], "/v1/memory/a%2Fb%3Fc%25d");
    assert_eq!(seen["query"], "x=1");
    for path in [
        "/meka/v1/x/../openapi.json",
        "/meka/v1/x/%2E%2e/openapi.json",
        "/meka/v1/%2e/openapi.json",
    ] {
        assert_eq!(
            send(&router, get(path)).await.status(),
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    for path in [
        "/meka/v1/openapi.json",
        "/meka/v1/openapi%2Ejson",
        "/meka/v2/x",
    ] {
        assert_eq!(
            send(&router, get(path)).await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
}

#[tokio::test]
async fn a_body_larger_than_meka_takes_is_refused() {
    let (_app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let post = |bytes: usize| {
        request("POST", "/meka/v1/import")
            .header(header::COOKIE, &cookie)
            .body(Body::from(vec![b'x'; bytes]))
            .unwrap()
    };
    let response = send(&router, post(1024)).await;
    assert_eq!(json(response).await["bytes"], 1024);
    assert_eq!(
        send(&router, post(10 * 1024 * 1024 + 1)).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn meka_refusing_its_token_does_not_sign_the_browser_out() {
    let (_app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let response = send(
        &router,
        request("GET", "/meka/v1/unauthorized")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(json(response).await["type"], "urn:mekaweb:meka-unavailable");
}

#[tokio::test]
async fn signing_a_device_out_ends_its_open_streams() {
    let (_app, router, _, _dir) = mekaweb().await;
    let cookie = sign_in(&router).await;
    let response = send(
        &router,
        request("GET", "/meka/v1/sessions/s1/stream")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    assert!(body.next().await.is_some(), "the first event arrives");
    let out = send(
        &router,
        request("POST", "/api/auth/sign-out")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(out.status(), StatusCode::NO_CONTENT);
    assert!(out.headers().contains_key("clear-site-data"));
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while body.next().await.is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "the stream ends with the sign-in");
}

#[tokio::test]
async fn changing_the_password_takes_the_current_one_and_signs_every_other_device_out() {
    let (_app, router, _, _dir) = mekaweb().await;
    let mine = sign_in(&router).await;
    let other = sign_in(&router).await;
    let change = |current: &str| {
        request("PUT", "/api/account/password")
            .header(header::COOKIE, &mine)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "current": current, "password": "another long password" })
                    .to_string(),
            ))
            .unwrap()
    };
    let wrong = send(&router, change("not the password")).await;
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    assert_eq!(json(wrong).await["type"], "urn:mekaweb:wrong-password");
    let response = send(&router, change(PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["count"], 1);
    let session = |cookie: &str| {
        request("GET", "/api/auth/session")
            .header(header::COOKIE, cookie)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        send(&router, session(&other)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(send(&router, session(&mine)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn passkey_challenges_are_limited_per_network() {
    let (_app, router, _, _dir) = mekaweb().await;
    let challenge = || {
        request("POST", "/api/auth/passkey/challenge")
            .body(Body::empty())
            .unwrap()
    };
    for _ in 0..20 {
        assert_eq!(send(&router, challenge()).await.status(), StatusCode::OK);
    }
    let refused = send(&router, challenge()).await;
    assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(refused.headers().contains_key(header::RETRY_AFTER));
}
