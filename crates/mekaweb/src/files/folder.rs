//! Folders held open to act on what is in them by name: the part of Files that differs by system.
//!
//! On Unix a folder is held by a descriptor, so what is done by name is done in the folder opened,
//! whatever its path names by then, and a symlink put in place of a name is never followed. On
//! Windows it is held by its path; a symlink or junction is still never followed, as each is
//! looked at before it is opened and then opened as itself.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::{ffi::OsStr, io};

use chrono::{DateTime, Utc};
#[cfg(all(unix, test))]
pub(crate) use unix::new_file_mode;
#[cfg(unix)]
pub(crate) use unix::{Disk, Folder, mode_of, open_regular, prepare, write_all_at};
#[cfg(windows)]
pub(crate) use windows::{Disk, Folder, mode_of, open_regular, prepare, write_all_at};

use super::Kind;

/// An entry, as looked at without following it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Stat {
    pub(crate) kind: Kind,
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
    /// Its permission bits, where the system has them.
    pub(crate) mode: Option<u32>,
    /// Whether the system marks it hidden, whatever its name.
    pub(crate) hidden: bool,
    /// The disk it is on.
    pub(crate) disk: Disk,
}

impl Folder {
    /// Whether `name` in this folder is another disk mounted there, or a bind mount.
    pub(crate) fn is_mount(&self, name: &OsStr) -> io::Result<bool> {
        if let Some(root) = self.mount_root(name) {
            return Ok(root);
        }
        Ok(self.stat(name)?.disk != self.disk()?)
    }

    /// Whether going into the folder `name`, which `stat` describes, leaves the disk `disk`.
    pub(crate) fn leaves_disk(&self, name: &OsStr, stat: &Stat, disk: Disk) -> bool {
        stat.disk != disk || self.mount_root(name) == Some(true)
    }
}
