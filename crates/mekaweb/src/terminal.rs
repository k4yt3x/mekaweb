//! Terminals: the user's login shell on a pseudo-terminal, or PowerShell on a pseudo console on
//! Windows, run by mekaweb and reached over a WebSocket. A shell outlives the connections to it,
//! keeping its recent output, since iOS suspends the app whenever it is out of sight: coming back,
//! from that device or another, replays what was missed and carries on. A shell nobody is attached
//! to or typing in is closed after the configured idle time.
//!
//! Closing a terminal hangs it up, as closing a terminal window does: the shell's process group is
//! sent `SIGHUP` and the pseudo-terminal is closed, which hangs up whatever else holds it, and the
//! shell's process group is killed if the shell has not ended a few seconds on. On Windows closing
//! the console tells what is attached to it to close, and the shell is killed if it has not. The
//! terminal ends when its shell does, even if jobs it started still hold the pseudo-terminal.

mod pty;

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::{
    sync::{broadcast, watch},
    task::AbortHandle,
};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::config::TerminalConfig;

/// How much recent output a terminal keeps to replay.
const SCROLLBACK_BYTES: usize = 512 * 1024;

/// The most terminals open at once.
const MAX_TERMINALS: usize = 20;

/// How often idle terminals are looked for.
const REAP_EVERY: Duration = Duration::from_secs(60);

/// How many output pieces a slow connection may fall behind by before it is dropped and
/// reconnects, replaying.
const OUTPUT_BACKLOG: usize = 1024;

/// How long a hung-up shell has to end before its process group is killed.
const HANG_UP_GRACE: Duration = Duration::from_secs(3);

/// How long input may wait for a program to read it before it is given up.
const INPUT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a terminal sends its connections.
#[derive(Debug, Clone)]
pub(crate) enum Output {
    /// Bytes the shell wrote.
    Data(Bytes),
    /// The shell ended, with its exit code if it had one.
    Exit(Option<i32>),
}

/// A terminal, as the list shows it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct TerminalView {
    pub(crate) id: String,
    /// The folder it started in.
    pub(crate) cwd: String,
    pub(crate) created_at: DateTime<Utc>,
    /// When it was last typed in, attached to or left.
    pub(crate) active_at: DateTime<Utc>,
    /// How many connections are attached.
    pub(crate) attached: usize,
    /// The meka session it belongs to, if any.
    pub(crate) session: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

/// Recent output, and the channel live output goes out on, kept under one lock so a connection
/// attaching takes the one and joins the other with nothing between.
struct Screen {
    scrollback: VecDeque<u8>,
    output: broadcast::Sender<Output>,
    exited: Option<Option<i32>>,
}

/// A running shell.
pub(crate) struct Terminal {
    id: String,
    cwd: PathBuf,
    session: Option<String>,
    created_at: DateTime<Utc>,
    /// The pseudo-terminal's writing half, until the terminal is closed.
    writer: tokio::sync::Mutex<Option<pty::Input>>,
    screen: Mutex<Screen>,
    active: Mutex<(Instant, DateTime<Utc>)>,
    size: Mutex<(u16, u16)>,
    attached: AtomicUsize,
    /// The shell, to hang up or kill.
    process: pty::Process,
    /// The task reading the pseudo-terminal, which holds its reading half.
    reader: Mutex<Option<AbortHandle>>,
    /// Whether the shell has ended.
    ended: watch::Receiver<bool>,
}

/// A connection attached to a terminal: what it missed, and what comes next.
pub(crate) struct Attachment {
    pub(crate) terminal: Arc<Terminal>,
    pub(crate) replay: Vec<u8>,
    /// Whether the shell has ended already, and how.
    pub(crate) exited: Option<Option<i32>>,
    pub(crate) output: broadcast::Receiver<Output>,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.terminal.attached.fetch_sub(1, Ordering::AcqRel);
        self.terminal.touch();
    }
}

impl Terminal {
    fn touch(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = (Instant::now(), Utc::now());
    }

    /// Whether the shell has ended.
    fn has_ended(&self) -> bool {
        self.screen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .exited
            .is_some()
    }

    fn view(&self) -> TerminalView {
        let (cols, rows) = *self
            .size
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        TerminalView {
            id: self.id.clone(),
            cwd: self.cwd.display().to_string(),
            created_at: self.created_at,
            active_at: self
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .1,
            attached: self.attached.load(Ordering::Acquire),
            session: self.session.clone(),
            cols,
            rows,
        }
    }

    /// Types `data` into the shell. Input a program does not read within [`INPUT_TIMEOUT`] is
    /// given up, so it cannot hold the terminal, and closing it, up for good.
    pub(crate) async fn input(&self, data: &[u8]) -> std::io::Result<()> {
        self.touch();
        let mut guard = self.writer.lock().await;
        let Some(writer) = guard.as_mut() else {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        };
        let written = tokio::time::timeout(INPUT_TIMEOUT, writer.write_all(data))
            .await
            .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into()));
        drop(guard);
        written
    }

    /// Resizes the terminal.
    pub(crate) async fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let cols = cols.clamp(2, 1000);
        let rows = rows.clamp(2, 500);
        self.writer
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("the terminal is closed"))?
            .resize(cols, rows)?;
        *self
            .size
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = (cols, rows);
        Ok(())
    }

    fn idle_for(&self) -> Duration {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0
            .elapsed()
    }

    /// Closes the pseudo-terminal: the reading half's task stops, and the writing half is
    /// dropped. What still holds the other end reads its end of input and is sent `SIGHUP`.
    async fn close_pty(&self) {
        if let Some(reader) = self
            .reader
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            reader.abort();
        }
        let writer = self.writer.lock().await.take();
        if let Some(writer) = writer {
            writer.close().await;
        }
    }

    /// Hangs the terminal up, and kills the shell's process group if it has not ended a moment
    /// later. Closing the pseudo-terminal waits for input being written, which counts against
    /// that moment, so a program that stops reading cannot keep the shell from being killed.
    async fn kill(&self) {
        self.process.hang_up();
        let mut ended = self.ended.clone();
        let hung_up = async {
            self.close_pty().await;
            // An error means the shell's end was published and the sender dropped: it ended.
            let _ended = ended.wait_for(|ended| *ended).await;
        };
        if tokio::time::timeout(HANG_UP_GRACE, hung_up).await.is_err() {
            self.process.kill();
        }
    }
}

/// The terminals open.
pub(crate) struct Terminals {
    config: TerminalConfig,
    open: Mutex<HashMap<String, Arc<Terminal>>>,
}

impl Terminals {
    /// No terminals yet, opened as `config` says.
    pub(crate) fn new(config: &TerminalConfig) -> Arc<Self> {
        Arc::new(Self {
            config: config.clone(),
            open: Mutex::new(HashMap::new()),
        })
    }

    /// Whether terminals may be opened.
    pub(crate) fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    fn open_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Terminal>>> {
        self.open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The terminals open, oldest first; with `session`, only that meka session's.
    pub(crate) fn list(&self, session: Option<&str>) -> Vec<TerminalView> {
        let mut views: Vec<TerminalView> = self
            .open_map()
            .values()
            .filter(|terminal| {
                session.is_none_or(|session| terminal.session.as_deref() == Some(session))
            })
            .map(|terminal| terminal.view())
            .collect();
        views.sort_by_key(|view| view.created_at);
        views
    }

    /// Opens a shell in `cwd`, `cols` by `rows`, for the meka session `session` if any. A session
    /// has one terminal: while its shell runs, opening another gives that one.
    pub(crate) fn open(
        self: &Arc<Self>,
        cwd: &Path,
        cols: u16,
        rows: u16,
        session: Option<String>,
    ) -> anyhow::Result<TerminalView> {
        if !self.config.enabled {
            anyhow::bail!("terminals are turned off in the config");
        }
        // Held until the terminal is in, so two opening a session's terminal at once get one.
        let mut open = self.open_map();
        if let Some(existing) = session.as_deref().and_then(|session| {
            open.values().find(|terminal| {
                terminal.session.as_deref() == Some(session) && !terminal.has_ended()
            })
        }) {
            return Ok(existing.view());
        }
        if open.len() >= MAX_TERMINALS {
            anyhow::bail!("{MAX_TERMINALS} terminals are open already; close one first");
        }
        if !cwd.is_dir() {
            anyhow::bail!("{} is not a folder", cwd.display());
        }
        let (cols, rows) = (cols.clamp(2, 1000), rows.clamp(2, 500));
        let shell = self.config.shell.clone().unwrap_or_else(pty::default_shell);
        let pty::Started {
            output: mut reader,
            input: writer,
            shell,
            process,
        } = pty::start(&shell, cwd, cols, rows)?;
        let (output, _) = broadcast::channel(OUTPUT_BACKLOG);
        let (ended_sender, ended) = watch::channel(false);
        let terminal = Arc::new(Terminal {
            id: Uuid::new_v4().to_string(),
            cwd: cwd.to_path_buf(),
            session,
            created_at: Utc::now(),
            writer: tokio::sync::Mutex::new(Some(writer)),
            screen: Mutex::new(Screen {
                scrollback: VecDeque::new(),
                output,
                exited: None,
            }),
            active: Mutex::new((Instant::now(), Utc::now())),
            size: Mutex::new((cols, rows)),
            attached: AtomicUsize::new(0),
            process,
            reader: Mutex::new(None),
            ended,
        });
        open.insert(terminal.id.clone(), Arc::clone(&terminal));
        drop(open);
        let reading = Arc::clone(&terminal);
        let task = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        // Output is not activity: a terminal left printing, with nobody
                        // attached or typing, is still reaped.
                        let data = Bytes::copy_from_slice(buffer.get(..read).unwrap_or_default());
                        let mut screen = reading
                            .screen
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        screen.scrollback.extend(data.iter());
                        let excess = screen.scrollback.len().saturating_sub(SCROLLBACK_BYTES);
                        screen.scrollback.drain(..excess);
                        publish(&screen, Output::Data(data));
                        drop(screen);
                    }
                }
            }
        });
        *terminal
            .reader
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task.abort_handle());
        // The shell's end is the terminal's, whatever still holds the pseudo-terminal open.
        let terminals = Arc::clone(self);
        let ending = Arc::clone(&terminal);
        tokio::spawn(async move {
            let code = shell.wait().await;
            // Give the reader a moment to pass on the shell's last words.
            if tokio::time::timeout(Duration::from_millis(200), task)
                .await
                .is_err()
            {
                tracing::debug!("jobs of an ended shell still hold its terminal");
            }
            ending.close_pty().await;
            {
                let mut screen = ending
                    .screen
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                screen.exited = Some(code);
                publish(&screen, Output::Exit(code));
                drop(screen);
            }
            // Jobs left behind lose the terminal, as they would its window.
            ending.process.hang_up();
            ended_sender.send_replace(true);
            terminals.open_map().remove(&ending.id);
            tracing::info!("a terminal's shell ended");
        });
        tracing::info!("a terminal opened in {}", cwd.display());
        Ok(terminal.view())
    }

    /// Attaches to the terminal `id`.
    pub(crate) fn attach(&self, id: &str) -> Option<Attachment> {
        let terminal = self.open_map().get(id).cloned()?;
        terminal.attached.fetch_add(1, Ordering::AcqRel);
        terminal.touch();
        let screen = terminal
            .screen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let replay: Vec<u8> = screen.scrollback.iter().copied().collect();
        let output = screen.output.subscribe();
        let exited = screen.exited;
        drop(screen);
        Some(Attachment {
            terminal,
            replay,
            exited,
            output,
        })
    }

    /// Closes the terminal `id`; whether it was open.
    pub(crate) async fn close(&self, id: &str) -> bool {
        let terminal = self.open_map().remove(id);
        match terminal {
            Some(terminal) => {
                terminal.kill().await;
                true
            }
            None => false,
        }
    }

    /// Closes the terminals of the meka session `session`, which is gone.
    pub(crate) async fn close_session(&self, session: &str) {
        let ids: Vec<String> = self
            .open_map()
            .values()
            .filter(|terminal| terminal.session.as_deref() == Some(session))
            .map(|terminal| terminal.id.clone())
            .collect();
        for id in ids {
            tracing::info!("closing a terminal whose session was deleted");
            self.close(&id).await;
        }
    }

    /// Closes every terminal, as mekaweb stops.
    pub(crate) async fn close_all(&self) {
        let terminals: Vec<Arc<Terminal>> = self
            .open_map()
            .drain()
            .map(|(_, terminal)| terminal)
            .collect();
        futures_util::future::join_all(terminals.iter().map(|terminal| terminal.kill())).await;
    }

    /// Closes the terminals nobody is attached to or typing in, every minute.
    pub(crate) async fn reap(self: Arc<Self>) {
        loop {
            tokio::time::sleep(REAP_EVERY).await;
            let idle: Vec<String> = self
                .open_map()
                .values()
                .filter(|terminal| {
                    terminal.attached.load(Ordering::Acquire) == 0
                        && terminal.idle_for() >= self.config.idle_timeout
                })
                .map(|terminal| terminal.id.clone())
                .collect();
            for id in idle {
                tracing::info!("closing a terminal left idle");
                self.close(&id).await;
            }
        }
    }
}

/// Sends `output` to the connections attached, if any are; the scrollback keeps it either way.
fn publish(screen: &Screen, output: Output) {
    if screen.output.send(output).is_err() {
        tracing::trace!("no connection is attached to the terminal");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TerminalConfig {
        TerminalConfig {
            enabled: true,
            idle_timeout: Duration::from_secs(60),
            shell: Some(PathBuf::from(if cfg!(windows) {
                "cmd.exe"
            } else {
                "/bin/sh"
            })),
        }
    }

    /// A line that has the shell work out a sum, and what it prints: not in the line itself, which
    /// the terminal echoes.
    fn sum() -> (&'static [u8], &'static str) {
        if cfg!(windows) {
            (b"set /a 40000+2\r\n", "40002")
        } else {
            (b"echo hello-$((40+2))\n", "hello-42")
        }
    }

    /// A line that ends the shell.
    const EXIT: &[u8] = if cfg!(windows) {
        b"exit\r\n"
    } else {
        b"exit\n"
    };

    async fn read_until(attachment: &mut Attachment, needle: &str) -> String {
        let mut seen = String::from_utf8_lossy(&attachment.replay).into_owned();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen.contains(needle) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, attachment.output.recv()).await {
                Ok(Ok(Output::Data(data))) => seen.push_str(&String::from_utf8_lossy(&data)),
                other => panic!("no {needle:?} in {seen:?}: {other:?}"),
            }
        }
        seen
    }

    #[tokio::test]
    async fn a_shell_runs_and_replays_to_a_connection_that_comes_back() {
        let terminals = Terminals::new(&config());
        let dir = tempfile::tempdir().unwrap();
        let view = terminals.open(dir.path(), 80, 24, None).unwrap();
        let mut first = terminals.attach(&view.id).unwrap();
        let (line, printed) = sum();
        first.terminal.input(line).await.unwrap();
        read_until(&mut first, printed).await;
        assert_eq!(terminals.list(None)[0].attached, 1);
        drop(first);
        let second = terminals.attach(&view.id).unwrap();
        assert!(String::from_utf8_lossy(&second.replay).contains(printed));
        let mut second = second;
        second.terminal.input(EXIT).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout(
                deadline.saturating_duration_since(Instant::now()),
                second.output.recv(),
            )
            .await
            {
                Ok(Ok(Output::Exit(_))) => break,
                Ok(Ok(Output::Data(_))) => {}
                other => panic!("the shell did not end: {other:?}"),
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(terminals.list(None).is_empty());
    }

    #[tokio::test]
    async fn closing_a_terminal_ends_its_shell() {
        let terminals = Terminals::new(&config());
        let dir = tempfile::tempdir().unwrap();
        let view = terminals.open(dir.path(), 80, 24, None).unwrap();
        assert!(terminals.close(&view.id).await);
        assert!(!terminals.close(&view.id).await);
        assert!(terminals.attach(&view.id).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closing_a_terminal_kills_a_shell_that_ignores_hang_ups() {
        let terminals = Terminals::new(&config());
        let dir = tempfile::tempdir().unwrap();
        let view = terminals.open(dir.path(), 80, 24, None).unwrap();
        let mut attachment = terminals.attach(&view.id).unwrap();
        // A shell that lets go of the terminal and ignores hang-ups.
        attachment
            .terminal
            .input(
                b"echo started-$((1+1)); trap '' HUP; exec sleep 30 </dev/null >/dev/null 2>&1\n",
            )
            .await
            .unwrap();
        read_until(&mut attachment, "started-2").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let closing = tokio::time::timeout(Duration::from_secs(10), terminals.close(&view.id));
        assert!(closing.await.unwrap(), "closing does not hang");
        let mut ended = attachment.terminal.ended.clone();
        let ended = tokio::time::timeout(Duration::from_secs(5), ended.wait_for(|ended| *ended));
        assert!(ended.await.is_ok(), "the shell was killed");
    }

    #[tokio::test]
    async fn a_session_finds_its_terminals_and_takes_them_when_it_goes() {
        let terminals = Terminals::new(&config());
        let dir = tempfile::tempdir().unwrap();
        let mine = terminals
            .open(dir.path(), 80, 24, Some("s1".to_owned()))
            .unwrap();
        terminals.open(dir.path(), 80, 24, None).unwrap();
        let again = terminals
            .open(dir.path(), 80, 24, Some("s1".to_owned()))
            .unwrap();
        assert_eq!(again.id, mine.id, "a session has one terminal");
        let listed = terminals.list(Some("s1"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, mine.id);
        assert_eq!(terminals.list(None).len(), 2);
        terminals.close_session("s1").await;
        assert!(terminals.list(Some("s1")).is_empty());
        assert_eq!(terminals.list(None).len(), 1);
        terminals.close_all().await;
    }

    #[test]
    fn a_shell_is_found() {
        let shell = pty::default_shell();
        assert!(shell.is_absolute() || cfg!(windows), "{}", shell.display());
    }
}
