//! Pseudo-terminals: the part of terminals that differs by system. On Unix a shell runs on a
//! pseudo-terminal in a session of its own, hung up and killed as a process group. On Windows it
//! runs on a pseudo console, which closing hangs up: everything attached to it is told to close.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(crate) use unix::{Input, Output, Process, Shell, default_shell, start};
#[cfg(windows)]
pub(crate) use windows::{Input, Output, Process, Shell, default_shell, start};

/// A shell started on a pseudo-terminal.
pub(crate) struct Started {
    /// What it writes.
    pub(crate) output: Output,
    /// Where what is typed goes.
    pub(crate) input: Input,
    /// The shell, to wait for.
    pub(crate) shell: Shell,
    /// The shell, to hang up or kill.
    pub(crate) process: Process,
}
