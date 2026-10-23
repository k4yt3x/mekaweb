//! Pseudo consoles on Windows, through portable-pty. Their pipes are read and written on threads
//! of their own, as Windows offers them only blocking.
//!
//! portable-pty starts a console that takes its cursor from the terminal: before anything else it
//! asks where the cursor is, and waits for the answer. A shell here starts before any browser is
//! attached, and a question left in the scrollback would be answered again by every browser that
//! attaches, typing the answer into the shell. So that first question is answered here, at the top
//! left of a new screen, and kept out of the output.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use bytes::Bytes;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use super::Started;

/// What the shell writes, as its reading thread passes it on.
pub(crate) struct Output {
    pieces: mpsc::Receiver<Bytes>,
    /// What was read but did not fit the last buffer.
    left: Bytes,
}

/// Where what is typed goes, and the console, which closes when this is dropped.
pub(crate) struct Input {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    console: Box<dyn MasterPty + Send>,
}

/// The shell, to wait for.
pub(crate) struct Shell(Box<dyn portable_pty::Child + Send + Sync>);

/// The shell, to kill.
pub(crate) struct Process(Mutex<Box<dyn ChildKiller + Send + Sync>>);

/// How a console asks where the cursor is.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";

/// Where a new screen's cursor is.
const CURSOR_HOME: &[u8] = b"\x1b[1;1R";

/// Starts `shell` in `cwd`, on a pseudo console `cols` by `rows`.
pub(crate) fn start(shell: &Path, cwd: &Path, cols: u16, rows: u16) -> anyhow::Result<Started> {
    let pair = portable_pty::native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(command)?;
    // The console closes once both its ends are dropped: the other is the input's.
    drop(pair.slave);
    let process = Process(Mutex::new(child.clone_killer()));
    let mut reader = pair.master.try_clone_reader()?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
    // Kept for the first read alone, so the input closes with the console.
    let mut answering = Some(Arc::clone(&writer));
    let (sender, pieces) = mpsc::channel(64);
    std::thread::Builder::new()
        .name("terminal output".to_owned())
        .spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            // Read to the end even once nobody listens: a console closing waits for what it
            // wrote to be read.
            loop {
                let read = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => buffer.get(..read).unwrap_or_default(),
                };
                let mut piece = read.to_vec();
                if let Some(answering) = answering.take()
                    && let Some(at) = piece
                        .windows(CURSOR_QUERY.len())
                        .position(|bytes| bytes == CURSOR_QUERY)
                {
                    piece.drain(at..at + CURSOR_QUERY.len());
                    let mut writer = answering.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Err(error) = writer.write_all(CURSOR_HOME).and_then(|()| writer.flush())
                    {
                        tracing::debug!("could not tell a console where its cursor is: {error}");
                    }
                }
                if !piece.is_empty() {
                    sender.blocking_send(Bytes::from(piece)).ok();
                }
            }
        })?;
    Ok(Started {
        output: Output {
            pieces,
            left: Bytes::new(),
        },
        input: Input {
            writer,
            console: pair.master,
        },
        shell: Shell(child),
        process,
    })
}

impl Output {
    /// Reads what the shell wrote into `buffer`; nothing at its end.
    pub(crate) async fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.left.is_empty() {
            match self.pieces.recv().await {
                Some(piece) => self.left = piece,
                None => return Ok(0),
            }
        }
        let count = buffer.len().min(self.left.len());
        let piece = self.left.split_to(count);
        if let Some(into) = buffer.get_mut(..count) {
            into.copy_from_slice(&piece);
        }
        Ok(count)
    }
}

impl Input {
    /// Types `data`.
    pub(crate) async fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        let writer = Arc::clone(&self.writer);
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
            writer.write_all(&data)?;
            writer.flush()
        })
        .await
        .map_err(std::io::Error::other)?
    }

    /// Resizes the console.
    pub(crate) fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.console.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    /// Closes the console, which tells everything attached to it to close. Closing it may wait
    /// for its output to be read, so it is done off the async runtime.
    pub(crate) async fn close(self) {
        if let Err(error) = tokio::task::spawn_blocking(move || drop(self)).await {
            tracing::debug!("could not close a terminal's console: {error}");
        }
    }
}

impl Shell {
    /// Waits for the shell to end; its exit code.
    pub(crate) async fn wait(mut self) -> Option<i32> {
        let status = tokio::task::spawn_blocking(move || self.0.wait())
            .await
            .ok()?
            .ok()?;
        Some(i32::from_ne_bytes(status.exit_code().to_ne_bytes()))
    }
}

impl Process {
    /// Hangs the shell up, which closing its console does on Windows.
    pub(crate) const fn hang_up(&self) {}

    /// Kills the shell.
    pub(crate) fn kill(&self) {
        let mut killer = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Err(error) = killer.kill() {
            tracing::debug!("could not kill a terminal's shell: {error}");
        }
    }
}

/// The shell a terminal runs on Windows: PowerShell, as meka uses.
pub(crate) fn default_shell() -> PathBuf {
    PathBuf::from("powershell.exe")
}
