//! The SQLite database in the state folder: the user, their passkeys, sign-ins and the devices they
//! came from, the sign-in log, push subscriptions, synced preferences, uploads in progress, and
//! mekaweb's own keys.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, bail};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;
use webauthn_rs::prelude::Passkey;

/// How long a write waits for another to finish before failing.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How many sign-in log entries are kept of each kind: those that got in, and those that did not.
/// Kept apart, so a flood of failures cannot push a sign-in out of the log.
const LOG_KEPT: i64 = 500;

/// The outcomes of attempts that got in.
const LOG_SUCCESSES: &str = "('signed-in', 'confirmed')";

/// Schema migrations, applied in order; `PRAGMA user_version` records how many ran.
const MIGRATIONS: &[&str] = &[
    r"
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        handle TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE passkeys (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        passkey TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
    );
    CREATE TABLE login_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        user_agent TEXT NOT NULL,
        method TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_ip TEXT NOT NULL,
        verified_at TEXT
    );
    CREATE TABLE login_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        username TEXT NOT NULL,
        ip TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        method TEXT NOT NULL,
        outcome TEXT NOT NULL
    );
    CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES login_sessions(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        dir TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        temp TEXT NOT NULL,
        active_at TEXT NOT NULL
    );
",
    r"
    -- Uploads go to any folder, named by its absolute path; one under way when mekaweb upgrades
    -- starts again.
    DROP TABLE uploads;
    CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        temp TEXT NOT NULL,
        active_at TEXT NOT NULL
    );
",
];

/// The person who signs in.
#[derive(Debug, Clone)]
pub(crate) struct UserRow {
    pub(crate) id: i64,
    pub(crate) username: String,
    pub(crate) password_hash: String,
    /// The WebAuthn user handle every passkey of theirs carries.
    pub(crate) handle: Uuid,
}

/// A passkey.
#[derive(Debug, Clone)]
pub(crate) struct PasskeyRow {
    pub(crate) id: String,
    pub(crate) user_id: i64,
    pub(crate) name: String,
    pub(crate) passkey: Passkey,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) last_used_at: Option<DateTime<Utc>>,
}

/// A sign-in, and the device it is on.
#[derive(Debug, Clone)]
pub(crate) struct SessionRow {
    pub(crate) id: String,
    pub(crate) user_id: i64,
    /// What the person named the device, if they did.
    pub(crate) name: Option<String>,
    pub(crate) user_agent: String,
    /// `password` or `passkey`.
    pub(crate) method: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) last_seen_at: DateTime<Utc>,
    pub(crate) last_ip: String,
    /// When the person last confirmed who they are on this device.
    pub(crate) verified_at: Option<DateTime<Utc>>,
}

/// A sign-in attempt.
#[derive(Debug, Clone)]
pub(crate) struct LogEntry {
    pub(crate) at: DateTime<Utc>,
    pub(crate) username: String,
    pub(crate) ip: String,
    pub(crate) user_agent: String,
    pub(crate) method: String,
    pub(crate) outcome: String,
}

/// Where a device receives push notifications.
#[derive(Debug, Clone)]
pub(crate) struct SubscriptionRow {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) endpoint: String,
    pub(crate) p256dh: String,
    pub(crate) auth: String,
}

/// An upload in progress.
#[derive(Debug, Clone)]
pub(crate) struct UploadRow {
    pub(crate) id: String,
    /// The folder it goes into, absolute.
    pub(crate) dir: String,
    pub(crate) name: String,
    pub(crate) size: u64,
    /// The hidden file it is written to, in the same folder.
    pub(crate) temp: String,
    /// When it began, or last took a piece.
    pub(crate) active_at: DateTime<Utc>,
}

/// The database.
#[derive(Clone)]
pub(crate) struct Store {
    connection: Arc<Mutex<Connection>>,
}

impl Store {
    /// The database at `path`, made and brought up to date.
    pub(crate) fn open(path: &Path) -> anyhow::Result<Self> {
        let connection = Connection::open(path)
            .with_context(|| format!("could not open the database at {}", path.display()))?;
        Self::prepare(connection)
    }

    /// A database that lives in memory, for tests.
    #[cfg(test)]
    pub(crate) fn in_memory() -> anyhow::Result<Self> {
        Self::prepare(Connection::open_in_memory()?)
    }

    fn prepare(mut connection: Connection) -> anyhow::Result<Self> {
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let applied: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let applied = usize::try_from(applied)?;
        // A database a newer mekaweb has changed is not touched: this one would lose track of
        // what was changed, and the newer one would change it again.
        if applied > MIGRATIONS.len() {
            bail!(
                "the database is from a newer mekaweb (schema {applied}, this one knows {}); run that \
                 version or a newer one",
                MIGRATIONS.len()
            );
        }
        let transaction = connection.transaction()?;
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied) {
            transaction
                .execute_batch(migration)
                .with_context(|| format!("migration {} failed", index + 1))?;
        }
        transaction.pragma_update(None, "user_version", i64::try_from(MIGRATIONS.len())?)?;
        transaction.commit()?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    /// Runs `work` on the connection off the async runtime.
    async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            // A task that panicked holding the connection rolled back its transaction as it
            // unwound, so the connection is taken back rather than every query failing.
            let mut connection = connection.lock().unwrap_or_else(|poisoned| {
                tracing::error!("a database task panicked; carrying on with its connection");
                poisoned.into_inner()
            });
            work(&mut connection)
        })
        .await
        .context("a database task panicked")?
    }

    // The user.

    /// The user, if one was added.
    pub(crate) async fn user(&self) -> anyhow::Result<Option<UserRow>> {
        self.call(|connection| {
            Ok(connection
                .query_row(
                    "SELECT id, username, password_hash, handle FROM users ORDER BY id LIMIT 1",
                    [],
                    user_row,
                )
                .optional()?)
        })
        .await
    }

    /// The user `id`.
    pub(crate) async fn user_by_id(&self, id: i64) -> anyhow::Result<Option<UserRow>> {
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT id, username, password_hash, handle FROM users WHERE id = ?1",
                    [id],
                    user_row,
                )
                .optional()?)
        })
        .await
    }

    /// Adds the user.
    pub(crate) async fn add_user(&self, username: &str, password_hash: &str) -> anyhow::Result<()> {
        let username = username.to_owned();
        let password_hash = password_hash.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO users (username, password_hash, handle, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![username, password_hash, Uuid::new_v4().to_string(), now()],
            )?;
            Ok(())
        })
        .await
    }

    /// Sets the user's password hash.
    pub(crate) async fn set_password(&self, user: i64, password_hash: &str) -> anyhow::Result<()> {
        let password_hash = password_hash.to_owned();
        self.call(move |connection| {
            connection.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                params![password_hash, user],
            )?;
            Ok(())
        })
        .await
    }

    // Passkeys.

    /// The user's passkeys, oldest first.
    pub(crate) async fn passkeys(&self, user: i64) -> anyhow::Result<Vec<PasskeyRow>> {
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, user_id, name, passkey, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at, id",
            )?;
            let rows = statement
                .query_map([user], passkey_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// The passkey whose credential id, in URL-safe base64, is `credential`.
    pub(crate) async fn passkey_by_credential(
        &self,
        credential: &str,
    ) -> anyhow::Result<Option<PasskeyRow>> {
        let credential = credential.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT id, user_id, name, passkey, created_at, last_used_at FROM passkeys WHERE credential_id = ?1",
                    [credential],
                    passkey_row,
                )
                .optional()?)
        })
        .await
    }

    /// Adds a passkey.
    pub(crate) async fn add_passkey(
        &self,
        user: i64,
        name: &str,
        credential: &str,
        passkey: &Passkey,
    ) -> anyhow::Result<PasskeyRow> {
        let row = PasskeyRow {
            id: Uuid::new_v4().to_string(),
            user_id: user,
            name: name.to_owned(),
            passkey: passkey.clone(),
            created_at: Utc::now(),
            last_used_at: None,
        };
        let stored = row.clone();
        let credential = credential.to_owned();
        let json = serde_json::to_string(passkey)?;
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO passkeys (id, user_id, name, credential_id, passkey, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![stored.id, stored.user_id, stored.name, credential, json, stored.created_at.to_rfc3339()],
            )?;
            Ok(())
        })
        .await?;
        Ok(row)
    }

    /// Records that a passkey signed in just now, with its new state when that changed.
    pub(crate) async fn passkey_used(
        &self,
        id: &str,
        passkey: Option<&Passkey>,
    ) -> anyhow::Result<()> {
        let id = id.to_owned();
        let json = passkey.map(serde_json::to_string).transpose()?;
        self.call(move |connection| {
            match json {
                Some(json) => connection.execute(
                    "UPDATE passkeys SET last_used_at = ?1, passkey = ?2 WHERE id = ?3",
                    params![now(), json, id],
                )?,
                None => connection.execute(
                    "UPDATE passkeys SET last_used_at = ?1 WHERE id = ?2",
                    params![now(), id],
                )?,
            };
            Ok(())
        })
        .await
    }

    /// Renames a passkey of `user`'s; whether it was there.
    pub(crate) async fn rename_passkey(
        &self,
        user: i64,
        id: &str,
        name: &str,
    ) -> anyhow::Result<bool> {
        let id = id.to_owned();
        let name = name.to_owned();
        self.call(move |connection| {
            Ok(connection.execute(
                "UPDATE passkeys SET name = ?1 WHERE id = ?2 AND user_id = ?3",
                params![name, id, user],
            )? > 0)
        })
        .await
    }

    /// Removes a passkey of `user`'s; whether it was there.
    pub(crate) async fn delete_passkey(&self, user: i64, id: &str) -> anyhow::Result<bool> {
        let id = id.to_owned();
        self.call(move |connection| {
            Ok(connection.execute(
                "DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2",
                params![id, user],
            )? > 0)
        })
        .await
    }

    // Sign-ins.

    /// Records a sign-in whose token hashes to `token_hash`.
    pub(crate) async fn add_session(
        &self,
        token_hash: &str,
        user: i64,
        user_agent: &str,
        method: &str,
        ip: &str,
    ) -> anyhow::Result<SessionRow> {
        let at = Utc::now();
        let row = SessionRow {
            id: Uuid::new_v4().to_string(),
            user_id: user,
            name: None,
            user_agent: user_agent.to_owned(),
            method: method.to_owned(),
            created_at: at,
            last_seen_at: at,
            last_ip: ip.to_owned(),
            // Signing in is confirming who you are.
            verified_at: Some(at),
        };
        let stored = row.clone();
        let token_hash = token_hash.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO login_sessions (id, token_hash, user_id, user_agent, method, created_at, last_seen_at, last_ip, verified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?6)",
                params![stored.id, token_hash, stored.user_id, stored.user_agent, stored.method, stored.created_at.to_rfc3339(), stored.last_ip],
            )?;
            Ok(())
        })
        .await?;
        Ok(row)
    }

    /// The sign-in whose token hashes to `token_hash`.
    pub(crate) async fn session_by_token(
        &self,
        token_hash: &str,
    ) -> anyhow::Result<Option<SessionRow>> {
        let token_hash = token_hash.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    &format!("{SESSION_COLUMNS} WHERE token_hash = ?1"),
                    [token_hash],
                    session_row,
                )
                .optional()?)
        })
        .await
    }

    /// The sign-in `id`.
    pub(crate) async fn session_by_id(&self, id: &str) -> anyhow::Result<Option<SessionRow>> {
        let id = id.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    &format!("{SESSION_COLUMNS} WHERE id = ?1"),
                    [id],
                    session_row,
                )
                .optional()?)
        })
        .await
    }

    /// Every sign-in of `user`, most recently seen first.
    pub(crate) async fn sessions(&self, user: i64) -> anyhow::Result<Vec<SessionRow>> {
        self.call(move |connection| {
            let mut statement = connection.prepare(&format!(
                "{SESSION_COLUMNS} WHERE user_id = ?1 ORDER BY last_seen_at DESC"
            ))?;
            let rows = statement
                .query_map([user], session_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// Notes that the sign-in `id` was used just now, from `ip`.
    pub(crate) async fn touch_session(&self, id: &str, ip: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        let ip = ip.to_owned();
        self.call(move |connection| {
            connection.execute(
                "UPDATE login_sessions SET last_seen_at = ?1, last_ip = ?2 WHERE id = ?3",
                params![now(), ip, id],
            )?;
            Ok(())
        })
        .await
    }

    /// Notes that the person confirmed who they are on the sign-in `id` just now.
    pub(crate) async fn verify_session(&self, id: &str) -> anyhow::Result<DateTime<Utc>> {
        let id = id.to_owned();
        let at = Utc::now();
        self.call(move |connection| {
            connection.execute(
                "UPDATE login_sessions SET verified_at = ?1 WHERE id = ?2",
                params![at.to_rfc3339(), id],
            )?;
            Ok(())
        })
        .await?;
        Ok(at)
    }

    /// Makes the sign-in `id`'s last confirmation a day old.
    #[cfg(test)]
    pub(crate) async fn age_verification_for_test(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        let at = (Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        self.call(move |connection| {
            connection.execute(
                "UPDATE login_sessions SET verified_at = ?1 WHERE id = ?2",
                params![at, id],
            )?;
            Ok(())
        })
        .await
    }

    /// Names the device of `user`'s sign-in `id`; whether it was there.
    pub(crate) async fn rename_session(
        &self,
        user: i64,
        id: &str,
        name: Option<&str>,
    ) -> anyhow::Result<bool> {
        let id = id.to_owned();
        let name = name.map(str::to_owned);
        self.call(move |connection| {
            Ok(connection.execute(
                "UPDATE login_sessions SET name = ?1 WHERE id = ?2 AND user_id = ?3",
                params![name, id, user],
            )? > 0)
        })
        .await
    }

    /// Ends `user`'s sign-in `id`, and its push subscription with it; whether it was there.
    pub(crate) async fn delete_session(&self, user: i64, id: &str) -> anyhow::Result<bool> {
        let id = id.to_owned();
        self.call(move |connection| {
            Ok(connection.execute(
                "DELETE FROM login_sessions WHERE id = ?1 AND user_id = ?2",
                params![id, user],
            )? > 0)
        })
        .await
    }

    /// Ends every sign-in of `user` but `keep`.
    pub(crate) async fn delete_other_sessions(
        &self,
        user: i64,
        keep: Option<&str>,
    ) -> anyhow::Result<usize> {
        let keep = keep.map(str::to_owned);
        self.call(move |connection| {
            Ok(connection.execute(
                "DELETE FROM login_sessions WHERE user_id = ?1 AND (?2 IS NULL OR id != ?2)",
                params![user, keep],
            )?)
        })
        .await
    }

    /// Ends the sign-ins last seen before `unused_since` or begun before `created_before`.
    pub(crate) async fn delete_expired_sessions(
        &self,
        unused_since: DateTime<Utc>,
        created_before: DateTime<Utc>,
    ) -> anyhow::Result<usize> {
        self.call(move |connection| {
            Ok(connection.execute(
                "DELETE FROM login_sessions WHERE last_seen_at < ?1 OR created_at < ?2",
                [unused_since.to_rfc3339(), created_before.to_rfc3339()],
            )?)
        })
        .await
    }

    // The sign-in log.

    /// Records a sign-in attempt, keeping the last [`LOG_KEPT`] of its kind.
    pub(crate) async fn log(&self, entry: LogEntry) -> anyhow::Result<()> {
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO login_log (at, username, ip, user_agent, method, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![entry.at.to_rfc3339(), entry.username, entry.ip, entry.user_agent, entry.method, entry.outcome],
            )?;
            transaction.execute(
                &format!(
                    "DELETE FROM login_log WHERE id IN (SELECT id FROM login_log WHERE (outcome IN {LOG_SUCCESSES}) = (?1 IN {LOG_SUCCESSES}) ORDER BY id DESC LIMIT -1 OFFSET ?2)"
                ),
                params![entry.outcome, LOG_KEPT],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    /// The sign-in log, newest first: the last `limit` attempts that got in, and the last `limit`
    /// that did not.
    pub(crate) async fn log_entries(&self, limit: usize) -> anyhow::Result<Vec<LogEntry>> {
        let limit = i64::try_from(limit).unwrap_or(LOG_KEPT);
        self.call(move |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT at, username, ip, user_agent, method, outcome FROM (
                     SELECT * FROM (SELECT * FROM login_log WHERE outcome IN {LOG_SUCCESSES} ORDER BY id DESC LIMIT ?1)
                     UNION ALL
                     SELECT * FROM (SELECT * FROM login_log WHERE outcome NOT IN {LOG_SUCCESSES} ORDER BY id DESC LIMIT ?1)
                 ) ORDER BY id DESC"
            ))?;
            let rows = statement
                .query_map([limit], |row| {
                    Ok(LogEntry {
                        at: time(row, 0)?,
                        username: row.get(1)?,
                        ip: row.get(2)?,
                        user_agent: row.get(3)?,
                        method: row.get(4)?,
                        outcome: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    // Push subscriptions.

    /// Sets the sign-in `session`'s push subscription, replacing any it had and any other sign-in
    /// holding the same endpoint.
    pub(crate) async fn set_subscription(
        &self,
        session: &str,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
    ) -> anyhow::Result<()> {
        let session = session.to_owned();
        let endpoint = endpoint.to_owned();
        let p256dh = p256dh.to_owned();
        let auth = auth.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM push_subscriptions WHERE session_id = ?1 OR endpoint = ?2",
                params![session, endpoint],
            )?;
            transaction.execute(
                "INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![Uuid::new_v4().to_string(), session, endpoint, p256dh, auth, now()],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    /// The sign-in `session`'s push subscription.
    pub(crate) async fn subscription(
        &self,
        session: &str,
    ) -> anyhow::Result<Option<SubscriptionRow>> {
        let session = session.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT id, session_id, endpoint, p256dh, auth FROM push_subscriptions WHERE session_id = ?1",
                    [session],
                    subscription_row,
                )
                .optional()?)
        })
        .await
    }

    /// Every push subscription.
    pub(crate) async fn subscriptions(&self) -> anyhow::Result<Vec<SubscriptionRow>> {
        self.call(|connection| {
            let mut statement = connection
                .prepare("SELECT id, session_id, endpoint, p256dh, auth FROM push_subscriptions")?;
            let rows = statement
                .query_map([], subscription_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// Removes the subscription `id`.
    pub(crate) async fn delete_subscription(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        self.call(move |connection| {
            connection.execute("DELETE FROM push_subscriptions WHERE id = ?1", [id])?;
            Ok(())
        })
        .await
    }

    /// Removes the sign-in `session`'s subscription.
    pub(crate) async fn delete_session_subscription(&self, session: &str) -> anyhow::Result<()> {
        let session = session.to_owned();
        self.call(move |connection| {
            connection.execute("DELETE FROM push_subscriptions WHERE session_id = ?1", [
                session,
            ])?;
            Ok(())
        })
        .await
    }

    // Preferences.

    /// The user's synced preferences, as the interface saved them.
    pub(crate) async fn preferences(&self, user: i64) -> anyhow::Result<Option<String>> {
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT value FROM preferences WHERE user_id = ?1",
                    [user],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await
    }

    /// Saves the user's synced preferences.
    pub(crate) async fn set_preferences(&self, user: i64, value: &str) -> anyhow::Result<()> {
        let value = value.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO preferences (user_id, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![user, value, now()],
            )?;
            Ok(())
        })
        .await
    }

    // Secrets.

    /// Keeps mekaweb's secret `name`, unless it has one already; the one it has after.
    pub(crate) async fn keep_secret(&self, name: &str, value: &str) -> anyhow::Result<String> {
        let name = name.to_owned();
        let value = value.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO secrets (name, value) VALUES (?1, ?2) ON CONFLICT (name) DO NOTHING",
                params![name, value],
            )?;
            Ok(connection.query_row(
                "SELECT value FROM secrets WHERE name = ?1",
                [name],
                |row| row.get(0),
            )?)
        })
        .await
    }

    // Uploads.

    /// Records an upload starting.
    pub(crate) async fn add_upload(&self, upload: &UploadRow) -> anyhow::Result<()> {
        let upload = upload.clone();
        let size = i64::try_from(upload.size)?;
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO uploads (id, dir, name, size, temp, active_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![upload.id, upload.dir, upload.name, size, upload.temp, upload.active_at.to_rfc3339()],
            )?;
            Ok(())
        })
        .await
    }

    /// The upload `id`.
    pub(crate) async fn upload(&self, id: &str) -> anyhow::Result<Option<UploadRow>> {
        let id = id.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT id, dir, name, size, temp, active_at FROM uploads WHERE id = ?1",
                    [id],
                    upload_row,
                )
                .optional()?)
        })
        .await
    }

    /// Notes that the upload `id` took a piece just now.
    pub(crate) async fn touch_upload(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        self.call(move |connection| {
            connection.execute("UPDATE uploads SET active_at = ?1 WHERE id = ?2", [
                Utc::now().to_rfc3339(),
                id,
            ])?;
            Ok(())
        })
        .await
    }

    /// The uploads idle since before `cutoff`.
    pub(crate) async fn uploads_before(
        &self,
        cutoff: DateTime<Utc>,
    ) -> anyhow::Result<Vec<UploadRow>> {
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, dir, name, size, temp, active_at FROM uploads WHERE active_at < ?1",
            )?;
            let rows = statement
                .query_map([cutoff.to_rfc3339()], upload_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// Forgets the upload `id`.
    pub(crate) async fn delete_upload(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        self.call(move |connection| {
            connection.execute("DELETE FROM uploads WHERE id = ?1", [id])?;
            Ok(())
        })
        .await
    }
}

const SESSION_COLUMNS: &str = "SELECT id, user_id, name, user_agent, method, created_at, last_seen_at, last_ip, verified_at FROM login_sessions";

/// Now, as the database writes it.
fn now() -> String {
    Utc::now().to_rfc3339()
}

/// The time in column `index`.
fn time(row: &Row<'_>, index: usize) -> rusqlite::Result<DateTime<Utc>> {
    let text: String = row.get(index)?;
    DateTime::parse_from_rfc3339(&text)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                error.into(),
            )
        })
}

/// The time in column `index`, which may be empty.
fn maybe_time(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<DateTime<Utc>>> {
    let text: Option<String> = row.get(index)?;
    text.map(|text| {
        DateTime::parse_from_rfc3339(&text)
            .map(|time| time.with_timezone(&Utc))
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })
    })
    .transpose()
}

fn user_row(row: &Row<'_>) -> rusqlite::Result<UserRow> {
    let handle: String = row.get(3)?;
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        password_hash: row.get(2)?,
        handle: Uuid::parse_str(&handle).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, error.into())
        })?,
    })
}

fn passkey_row(row: &Row<'_>) -> rusqlite::Result<PasskeyRow> {
    let json: String = row.get(3)?;
    Ok(PasskeyRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        passkey: serde_json::from_str(&json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, error.into())
        })?,
        created_at: time(row, 4)?,
        last_used_at: maybe_time(row, 5)?,
    })
}

fn session_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        user_agent: row.get(3)?,
        method: row.get(4)?,
        created_at: time(row, 5)?,
        last_seen_at: time(row, 6)?,
        last_ip: row.get(7)?,
        verified_at: maybe_time(row, 8)?,
    })
}

fn subscription_row(row: &Row<'_>) -> rusqlite::Result<SubscriptionRow> {
    Ok(SubscriptionRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        endpoint: row.get(2)?,
        p256dh: row.get(3)?,
        auth: row.get(4)?,
    })
}

fn upload_row(row: &Row<'_>) -> rusqlite::Result<UploadRow> {
    let size: i64 = row.get(3)?;
    Ok(UploadRow {
        id: row.get(0)?,
        dir: row.get(1)?,
        name: row.get(2)?,
        size: u64::try_from(size).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Integer,
                error.into(),
            )
        })?,
        temp: row.get(4)?,
        active_at: time(row, 5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_database_from_a_newer_version_is_refused() {
        let connection = Connection::open_in_memory().unwrap();
        let newer = i64::try_from(MIGRATIONS.len() + 1).unwrap();
        connection
            .pragma_update(None, "user_version", newer)
            .unwrap();
        let error = Store::prepare(connection).err().unwrap();
        assert!(format!("{error:#}").contains("newer mekaweb"), "{error:#}");
    }

    #[tokio::test]
    async fn ending_a_sign_in_ends_its_push_subscription() {
        let store = Store::in_memory().unwrap();
        store.add_user("me", "hash").await.unwrap();
        let user = store.user().await.unwrap().unwrap();
        let session = store
            .add_session("token", user.id, "agent", "password", "127.0.0.1")
            .await
            .unwrap();
        store
            .set_subscription(&session.id, "https://push.example/1", "key", "auth")
            .await
            .unwrap();
        assert!(store.subscription(&session.id).await.unwrap().is_some());
        assert!(store.delete_session(user.id, &session.id).await.unwrap());
        assert!(store.subscriptions().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_log_keeps_its_newest_entries_of_each_kind() {
        let store = Store::in_memory().unwrap();
        let entry = |username: String, outcome: &str| LogEntry {
            at: Utc::now(),
            username,
            ip: "127.0.0.1".to_owned(),
            user_agent: String::new(),
            method: "password".to_owned(),
            outcome: outcome.to_owned(),
        };
        store
            .log(entry("owner".to_owned(), "signed-in"))
            .await
            .unwrap();
        for index in 0..(LOG_KEPT + 5) {
            store
                .log(entry(format!("user{index}"), "wrong"))
                .await
                .unwrap();
        }
        let entries = store.log_entries(1000).await.unwrap();
        assert_eq!(entries.len(), usize::try_from(LOG_KEPT).unwrap() + 1);
        assert_eq!(entries[0].username, format!("user{}", LOG_KEPT + 4));
        assert_eq!(
            entries.last().unwrap().username,
            "owner",
            "a flood of failures leaves the sign-in"
        );
    }

    #[tokio::test]
    async fn a_secret_once_kept_is_not_replaced() {
        let store = Store::in_memory().unwrap();
        assert_eq!(store.keep_secret("key", "first").await.unwrap(), "first");
        assert_eq!(store.keep_secret("key", "second").await.unwrap(), "first");
    }
}
