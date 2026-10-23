//! Folders on Unix, held by descriptors.

use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io,
    os::{
        fd::OwnedFd,
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::{FileExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
};

use chrono::{TimeZone, Utc};
use rustix::fs::{AtFlags, FileType, Mode, OFlags, RawMode, RenameFlags};

use super::Stat;
use crate::files::Kind;

/// The disk an entry is on.
pub(crate) type Disk = rustix::fs::Dev;

/// How a folder is held to act in by name. On Linux it is not opened to read, so one that may be
/// gone through but not listed can still be acted in.
#[cfg(target_os = "linux")]
const HOLD: OFlags = OFlags::PATH;
#[cfg(not(target_os = "linux"))]
const HOLD: OFlags = OFlags::RDONLY;

/// A folder, held by a descriptor.
pub(crate) struct Folder {
    fd: OwnedFd,
}

impl Folder {
    /// Opens the folder `path`, its symlinks followed.
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let fd = rustix::fs::open(
            path,
            HOLD | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Self { fd })
    }

    /// Opens the folder `path`, its symlinks followed, if mekaweb may read what it holds.
    pub(crate) fn open_readable(path: &Path) -> io::Result<Self> {
        let fd = rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Self { fd })
    }

    /// The names in it, but `.` and `..`.
    pub(crate) fn names(&self) -> io::Result<Vec<OsString>> {
        let fd = rustix::fs::openat(
            &self.fd,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let mut names = Vec::new();
        for item in rustix::fs::Dir::read_from(&fd)? {
            let item = item?;
            let name = item.file_name().to_bytes();
            if name != b"." && name != b".." {
                names.push(OsStr::from_bytes(name).to_owned());
            }
        }
        Ok(names)
    }

    /// `name` in it, a symlink as itself.
    pub(crate) fn stat(&self, name: &OsStr) -> io::Result<Stat> {
        Ok(stat_of(&rustix::fs::statat(
            &self.fd,
            name,
            AtFlags::SYMLINK_NOFOLLOW,
        )?))
    }

    /// `name` in it, a symlink as what it leads to.
    pub(crate) fn stat_followed(&self, name: &OsStr) -> io::Result<Stat> {
        Ok(stat_of(&rustix::fs::statat(
            &self.fd,
            name,
            AtFlags::empty(),
        )?))
    }

    /// The disk it is on.
    pub(crate) fn disk(&self) -> io::Result<Disk> {
        Ok(rustix::fs::fstat(&self.fd)?.st_dev)
    }

    /// Whether `name` in it is the root of a mount, where the kernel says (Linux 5.8 on): a bind
    /// mount is on the same disk, and cannot be told by its disk.
    #[cfg(target_os = "linux")]
    pub(crate) fn mount_root(&self, name: &OsStr) -> Option<bool> {
        let stat = rustix::fs::statx(
            &self.fd,
            name,
            AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
            rustix::fs::StatxFlags::empty(),
        )
        .ok()?;
        let flag = rustix::fs::StatxAttributes::MOUNT_ROOT;
        stat.stx_attributes_mask
            .contains(flag)
            .then(|| stat.stx_attributes.contains(flag))
    }

    /// Whether `name` in it is the root of a mount, which only Linux says: elsewhere a mount is
    /// told by its disk.
    #[cfg(not(target_os = "linux"))]
    pub(crate) const fn mount_root(&self, _name: &OsStr) -> Option<bool> {
        None
    }

    /// Where the symlink `name` in it points, as written.
    pub(crate) fn read_link(&self, name: &OsStr) -> io::Result<PathBuf> {
        let target = rustix::fs::readlinkat(&self.fd, name, Vec::new())?;
        Ok(PathBuf::from(OsString::from_vec(target.into_bytes())))
    }

    /// Opens the folder `name` in it, which must not be a symlink.
    pub(crate) fn open_folder(&self, name: &OsStr) -> io::Result<Self> {
        let fd = rustix::fs::openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Self { fd })
    }

    /// Opens `name` in it to read, or with `write` to write, never through a symlink, and so
    /// that a named pipe cannot hold the thread waiting for its other end. Whether it is a
    /// regular file is for the caller to look at.
    pub(crate) fn open_file(&self, name: &OsStr, write: bool) -> io::Result<File> {
        let access = if write {
            OFlags::WRONLY
        } else {
            OFlags::RDONLY
        };
        let fd = rustix::fs::openat(
            &self.fd,
            name,
            access | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(File::from(fd))
    }

    /// Makes the file `name` in it, to write, which only its owner may read; never over anything.
    pub(crate) fn create_new(&self, name: &OsStr) -> io::Result<File> {
        let fd = rustix::fs::openat(
            &self.fd,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )?;
        Ok(File::from(fd))
    }

    /// Makes the folder `name` in it.
    pub(crate) fn make_folder(&self, name: &OsStr) -> io::Result<()> {
        Ok(rustix::fs::mkdirat(
            &self.fd,
            name,
            Mode::from_raw_mode(0o777),
        )?)
    }

    /// Removes `name` in it, which is not a folder; a symlink goes, not what it leads to.
    pub(crate) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        Ok(rustix::fs::unlinkat(&self.fd, name, AtFlags::empty())?)
    }

    /// Removes the empty folder `name` in it.
    pub(crate) fn remove_folder(&self, name: &OsStr) -> io::Result<()> {
        Ok(rustix::fs::unlinkat(&self.fd, name, AtFlags::REMOVEDIR)?)
    }

    /// Moves `from` in it to `to` in the folder `into`; over what is there only if `replace`.
    pub(crate) fn rename(
        &self,
        from: &OsStr,
        into: &Self,
        to: &OsStr,
        replace: bool,
    ) -> io::Result<()> {
        let flags = if replace {
            RenameFlags::empty()
        } else {
            RenameFlags::NOREPLACE
        };
        Ok(rustix::fs::renameat_with(
            &self.fd, from, &into.fd, to, flags,
        )?)
    }

    /// Gives the finished upload `file` its mode: that of the regular file `name` in it, if it
    /// replaces that, else the one new files get.
    pub(crate) fn give_mode(&self, file: &File, name: &OsStr, replace: bool) -> io::Result<()> {
        let mode = rustix::fs::statat(&self.fd, name, AtFlags::SYMLINK_NOFOLLOW)
            .ok()
            .filter(|_| replace)
            .filter(|existing| FileType::from_raw_mode(existing.st_mode) == FileType::RegularFile)
            .map_or_else(new_mode, |existing| existing.st_mode & 0o7777);
        Ok(rustix::fs::fchmod(file, Mode::from_raw_mode(mode))?)
    }
}

/// Reads what Files needs from the process, first thing in `main`: off Linux, the umask, which can
/// only be read by setting it, and so is read once, before any thread could make a file meanwhile.
pub(crate) fn prepare() {
    #[cfg(not(target_os = "linux"))]
    umask();
}

/// An entry as looked at.
fn stat_of(stat: &rustix::fs::Stat) -> Stat {
    let kind = match FileType::from_raw_mode(stat.st_mode) {
        FileType::Symlink => Kind::Symlink,
        FileType::Directory => Kind::Folder,
        FileType::RegularFile => Kind::File,
        _ => Kind::Other,
    };
    let nanos = u32::try_from(stat.st_mtime_nsec).unwrap_or_default();
    Stat {
        kind,
        size: u64::try_from(stat.st_size).unwrap_or_default(),
        modified: Utc.timestamp_opt(stat.st_mtime, nanos).single(),
        mode: Some(mode_bits(stat.st_mode)),
        hidden: false,
        disk: stat.st_dev,
    }
}

/// A mode as a `u32`, which it already is but on macOS.
#[allow(
    clippy::useless_conversion,
    reason = "a mode is a u16 on macOS and a u32 on Linux"
)]
fn mode_bits(mode: RawMode) -> u32 {
    u32::from(mode)
}

/// A file's permission bits.
pub(crate) fn mode_of(metadata: &Metadata) -> Option<u32> {
    Some(metadata.permissions().mode())
}

/// The mode a new file gets: read and write for all, less the process's umask.
fn new_mode() -> RawMode {
    0o666 & !umask()
}

/// The mode a new file gets, for tests.
#[cfg(test)]
pub(crate) fn new_file_mode() -> u32 {
    mode_bits(new_mode())
}

/// The process's umask, as Linux says it.
#[cfg(target_os = "linux")]
fn umask() -> RawMode {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("Umask:"))
                .and_then(|value| RawMode::from_str_radix(value.trim(), 8).ok())
        })
        .unwrap_or(0o022)
}

/// The process's umask, read once by setting it and putting it back.
#[cfg(not(target_os = "linux"))]
fn umask() -> RawMode {
    static UMASK: std::sync::OnceLock<RawMode> = std::sync::OnceLock::new();
    *UMASK.get_or_init(|| {
        let mask = rustix::process::umask(Mode::empty());
        rustix::process::umask(mask);
        mask.bits()
    })
}

/// Writes all of `bytes` into `file` at `offset`.
pub(crate) fn write_all_at(file: &File, bytes: &[u8], offset: u64) -> io::Result<()> {
    file.write_all_at(bytes, offset)
}

/// Opens `path`, its symlinks followed, to read, if it is a regular file; none if it is not. It is
/// looked at before it is opened to read, so neither a named pipe nor a device, which can act on
/// being opened, is.
#[cfg(target_os = "linux")]
pub(crate) fn open_regular(path: &Path) -> io::Result<Option<File>> {
    use std::os::fd::AsRawFd;
    let handle = rustix::fs::open(path, OFlags::PATH | OFlags::CLOEXEC, Mode::empty())?;
    if FileType::from_raw_mode(rustix::fs::fstat(&handle)?.st_mode) != FileType::RegularFile {
        return Ok(None);
    }
    // Opened again through the handle: the file looked at, whatever the path names by now.
    let fd = rustix::fs::open(
        format!("/proc/self/fd/{}", handle.as_raw_fd()),
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let file = File::from(fd);
    Ok(file.metadata()?.is_file().then_some(file))
}

/// Opens `path`, its symlinks followed, to read, if it is a regular file; none if it is not. It is
/// looked at before it is opened, and opened without waiting, so a named pipe is not read; what is
/// opened must be what was looked at.
#[cfg(not(target_os = "linux"))]
pub(crate) fn open_regular(path: &Path) -> io::Result<Option<File>> {
    let looked = rustix::fs::stat(path)?;
    if FileType::from_raw_mode(looked.st_mode) != FileType::RegularFile {
        return Ok(None);
    }
    let fd = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let opened = rustix::fs::fstat(&fd)?;
    let same = opened.st_dev == looked.st_dev && opened.st_ino == looked.st_ino;
    Ok(
        (same && FileType::from_raw_mode(opened.st_mode) == FileType::RegularFile)
            .then(|| File::from(fd)),
    )
}
