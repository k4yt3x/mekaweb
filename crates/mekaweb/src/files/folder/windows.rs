//! Folders on Windows, held by their paths. A symlink, a junction, or a disk mounted on a folder is
//! a reparse point standing for another name, which Windows says is a symlink: it is never followed
//! or gone into, and is acted on as itself.

use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata, OpenOptions},
    io,
    os::windows::{
        ffi::OsStrExt,
        fs::{FileExt, FileTypeExt, MetadataExt},
    },
    path::{Component, Path, PathBuf, Prefix},
};

use chrono::{DateTime, Utc};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_HIDDEN, MOVEFILE_REPLACE_EXISTING, MoveFileExW,
};

use super::Stat;
use crate::files::Kind;

/// The disk an entry is on, which Files need not tell apart on Windows: it never goes into a disk
/// mounted on a folder, which is a reparse point.
pub(crate) type Disk = u64;

/// A folder, held by its path.
pub(crate) struct Folder {
    path: PathBuf,
}

impl Folder {
    /// Opens the folder `path`, its symlinks followed.
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        if !std::fs::metadata(path)?.is_dir() {
            return Err(io::ErrorKind::NotADirectory.into());
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    /// Opens the folder `path`, its symlinks followed, if mekaweb may read what it holds.
    pub(crate) fn open_readable(path: &Path) -> io::Result<Self> {
        let folder = Self::open(path)?;
        drop(std::fs::read_dir(path)?);
        Ok(folder)
    }

    /// The names in it.
    pub(crate) fn names(&self) -> io::Result<Vec<OsString>> {
        std::fs::read_dir(&self.path)?
            .map(|item| item.map(|item| item.file_name()))
            .collect()
    }

    /// `name` in it, a symlink as itself.
    pub(crate) fn stat(&self, name: &OsStr) -> io::Result<Stat> {
        Ok(stat_of(&std::fs::symlink_metadata(self.path.join(name))?))
    }

    /// `name` in it, a symlink as what it leads to.
    pub(crate) fn stat_followed(&self, name: &OsStr) -> io::Result<Stat> {
        Ok(stat_of(&std::fs::metadata(self.path.join(name))?))
    }

    /// The disk it is on, which is never told apart.
    pub(crate) const fn disk(&self) -> io::Result<Disk> {
        Ok(0)
    }

    /// Whether `name` in it is the root of a mount, which Windows does not say this way: a disk
    /// mounted on a folder is a reparse point, never gone into.
    pub(crate) const fn mount_root(&self, _name: &OsStr) -> Option<bool> {
        None
    }

    /// Where the symlink or junction `name` in it points, as written.
    pub(crate) fn read_link(&self, name: &OsStr) -> io::Result<PathBuf> {
        std::fs::read_link(self.path.join(name))
    }

    /// Opens the folder `name` in it, which must not be a symlink or junction.
    pub(crate) fn open_folder(&self, name: &OsStr) -> io::Result<Self> {
        let path = self.path.join(name);
        let file_type = std::fs::symlink_metadata(&path)?.file_type();
        if file_type.is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a symlink is not gone into",
            ));
        }
        if !file_type.is_dir() {
            return Err(io::ErrorKind::NotADirectory.into());
        }
        Ok(Self { path })
    }

    /// Opens `name` in it to read, or with `write` to write, if it is not a symlink or junction.
    /// It is looked at first rather than opened as a reparse point, which would open a cloud
    /// file's placeholder, such as OneDrive's, instead of its contents. Whether it is a regular
    /// file is for the caller to look at.
    pub(crate) fn open_file(&self, name: &OsStr, write: bool) -> io::Result<File> {
        let path = self.path.join(name);
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a symlink is not opened",
            ));
        }
        OpenOptions::new().read(!write).write(write).open(path)
    }

    /// Makes the file `name` in it, to write; never over anything.
    pub(crate) fn create_new(&self, name: &OsStr) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(name))
    }

    /// Makes the folder `name` in it.
    pub(crate) fn make_folder(&self, name: &OsStr) -> io::Result<()> {
        std::fs::create_dir(self.path.join(name))
    }

    /// Removes `name` in it, which is not a folder; a symlink or junction goes, not what it leads
    /// to. One marked read-only goes too, as it would on Unix.
    pub(crate) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        let path = self.path.join(name);
        if std::fs::symlink_metadata(&path)?
            .file_type()
            .is_symlink_dir()
        {
            return std::fs::remove_dir(&path);
        }
        writable_then(&path, || std::fs::remove_file(&path))
    }

    /// Removes the empty folder `name` in it, even one marked read-only.
    pub(crate) fn remove_folder(&self, name: &OsStr) -> io::Result<()> {
        let path = self.path.join(name);
        writable_then(&path, || std::fs::remove_dir(&path))
    }

    /// Moves `from` in it to `to` in the folder `into`; over what is there only if `replace`.
    pub(crate) fn rename(
        &self,
        from: &OsStr,
        into: &Self,
        to: &OsStr,
        replace: bool,
    ) -> io::Result<()> {
        let from = wide(&self.path.join(from));
        let to = wide(&into.path.join(to));
        let flags = if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
        // SAFETY: both are NUL-terminated wide strings that live through the call.
        let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) };
        if moved == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Gives the finished upload `file` its mode, which Windows does not have.
    pub(crate) const fn give_mode(
        &self,
        _file: &File,
        _name: &OsStr,
        _replace: bool,
    ) -> io::Result<()> {
        Ok(())
    }
}

/// Reads what Files needs from the process, first thing in `main`, which on Windows is nothing.
pub(crate) const fn prepare() {}

/// Does `act` to `path`; if it is refused for `path` being marked read-only, unmarks it and tries
/// again.
fn writable_then(path: &Path, act: impl Fn() -> io::Result<()>) -> io::Result<()> {
    match act() {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = std::fs::symlink_metadata(path)?.permissions();
            if !permissions.readonly() {
                return Err(error);
            }
            #[expect(
                clippy::permissions_set_readonly_false,
                reason = "on Windows this clears only the read-only mark"
            )]
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
            act()
        }
        result => result,
    }
}

/// `path` as a NUL-terminated wide string, in the form that lifts the 260-character limit: an
/// absolute path Files resolved holds no `.` or `..` and no `/`, which that form does not undo.
fn wide(path: &Path) -> Vec<u16> {
    let written: Vec<u16> = path.as_os_str().encode_wide().collect();
    let prefix = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => Some((r"\\?\", 0)),
            // `\\server\share` becomes `\\?\UNC\server\share`.
            Prefix::UNC(..) => Some((r"\\?\UNC\", 2)),
            _ => None,
        },
        _ => None,
    };
    let mut long: Vec<u16> = Vec::with_capacity(written.len() + 9);
    match prefix {
        Some((prefix, skip)) => {
            long.extend(OsStr::new(prefix).encode_wide());
            long.extend(written.get(skip..).unwrap_or_default());
        }
        None => long.extend(written),
    }
    long.push(0);
    long
}

/// An entry as looked at.
fn stat_of(metadata: &Metadata) -> Stat {
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        Kind::Symlink
    } else if file_type.is_dir() {
        Kind::Folder
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Stat {
        kind,
        size: metadata.len(),
        modified: metadata.modified().ok().map(DateTime::<Utc>::from),
        mode: None,
        hidden: metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0,
        disk: 0,
    }
}

/// A file's permission bits, which Windows does not have.
pub(crate) const fn mode_of(_metadata: &Metadata) -> Option<u32> {
    None
}

/// Writes all of `bytes` into `file` at `offset`.
pub(crate) fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
    while !bytes.is_empty() {
        match file.seek_write(bytes, offset) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(written) => {
                bytes = bytes.get(written..).unwrap_or_default();
                offset += written as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Opens `path`, its symlinks followed, to read, if it is a regular file; none if it is not.
pub(crate) fn open_regular(path: &Path) -> io::Result<Option<File>> {
    if !std::fs::metadata(path)?.is_file() {
        return Ok(None);
    }
    let file = File::open(path)?;
    Ok(file.metadata()?.is_file().then_some(file))
}
