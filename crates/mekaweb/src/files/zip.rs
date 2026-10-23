//! A folder downloaded as a zip, written as it is read: nothing waits for the whole archive, and
//! nothing of it is kept. Symlinks inside are left out, so a link cannot pull in what is outside
//! the folder; so are named pipes and devices, which have no contents to read, other disks mounted
//! inside, and folders deeper than [`super::MAX_DEPTH`]. What was left out, besides symlinks, is
//! logged.

use std::{
    cell::RefCell,
    ffi::OsStr,
    fs::File,
    io::Write,
    os::{
        fd::{AsFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    rc::Rc,
};

use bytes::Bytes;
use chrono::{Datelike, TimeZone, Timelike, Utc};
use rustix::fs::{AtFlags, FileType, Mode, OFlags};
use tokio::sync::mpsc;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

/// How many bytes are gathered before they are sent on.
const SEND_BYTES: usize = 256 * 1024;

/// What a [`ChannelWriter`] has not sent yet, which can still be corrected, and how much it sent.
#[derive(Default)]
struct Pending {
    buffer: Vec<u8>,
    sent: u64,
    /// Kept back while an entry's header is written, so it can be corrected whole.
    holding: bool,
}

impl Pending {
    /// Where the next byte goes in the archive.
    fn position(&self) -> u64 {
        self.sent + self.buffer.len() as u64
    }
}

/// Writes into a channel, a piece at a time.
struct ChannelWriter {
    sender: mpsc::Sender<std::io::Result<Bytes>>,
    pending: Rc<RefCell<Pending>>,
}

impl ChannelWriter {
    fn send(&mut self) -> std::io::Result<()> {
        let mut pending = self.pending.borrow_mut();
        if pending.buffer.is_empty() {
            return Ok(());
        }
        let bytes = Bytes::from(std::mem::take(&mut pending.buffer));
        pending.sent += bytes.len() as u64;
        drop(pending);
        self.sender.blocking_send(Ok(bytes)).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the download stopped")
        })
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let full = {
            let mut pending = self.pending.borrow_mut();
            pending.buffer.extend_from_slice(data);
            !pending.holding && pending.buffer.len() >= SEND_BYTES
        };
        if full {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// Writes the folder `dir` as a zip into `sender`, its entries under `prefix/`; with `only`, just
/// those names in it. Runs until the archive ends or the download stops.
pub(crate) fn write(
    dir: OwnedFd,
    prefix: String,
    only: Option<Vec<String>>,
    sender: mpsc::Sender<std::io::Result<Bytes>>,
) {
    let error_sender = sender.clone();
    let pending = Rc::new(RefCell::new(Pending::default()));
    let writer = ChannelWriter {
        sender,
        pending: Rc::clone(&pending),
    };
    let mut zip = ZipWriter::new_stream(writer);
    let result =
        add_tree(&mut zip, &pending, dir, &entry_name(&prefix), only).and_then(|left_out| {
            if left_out > 0 {
                tracing::warn!("a zip of {prefix} left out {left_out} entries it could not read");
            }
            let mut writer = zip.finish().map_err(std::io::Error::other)?;
            writer.flush()
        });
    if let Err(error) = result
        && error.kind() != std::io::ErrorKind::BrokenPipe
    {
        tracing::warn!("a folder's zip stopped: {error}");
        if let Err(error) = error_sender.blocking_send(Err(error)) {
            tracing::debug!("the download was gone already: {error}");
        }
    }
}

/// A name as an archive's entry: a `\\`, which some unzippers take for a folder's end, is
/// written as `_`.
fn entry_name(name: &str) -> String {
    name.replace('\\', "_")
}

/// A folder being added: its path in the archive, and the names in it left to add.
struct Adding {
    fd: OwnedFd,
    path: String,
    left: std::vec::IntoIter<Vec<u8>>,
}

impl Adding {
    /// Adds the folder `fd` as `path/`, and reads what it holds.
    fn start<W: Write>(
        zip: &mut ZipWriter<zip::write::StreamWriter<W>>,
        fd: OwnedFd,
        path: String,
    ) -> std::io::Result<Self> {
        // A folder's entry has no data descriptor, so it is never ZIP64 in its local header.
        zip.add_directory(format!("{path}/"), options(None, 0o755, false))
            .map_err(std::io::Error::other)?;
        let mut names: Vec<Vec<u8>> = rustix::fs::Dir::read_from(&fd)?
            .filter_map(Result::ok)
            .map(|item| item.file_name().to_bytes().to_vec())
            .filter(|name| name != b"." && name != b"..")
            .collect();
        names.sort();
        Ok(Self {
            fd,
            path,
            left: names.into_iter(),
        })
    }
}

/// Adds the folder `dir` and what it holds under `prefix/`, or with `only` just those names in
/// it; how many entries were left out.
fn add_tree<W: Write>(
    zip: &mut ZipWriter<zip::write::StreamWriter<W>>,
    pending: &RefCell<Pending>,
    dir: OwnedFd,
    prefix: &str,
    only: Option<Vec<String>>,
) -> std::io::Result<usize> {
    let disk = rustix::fs::fstat(&dir)?.st_dev;
    let mut left_out = 0;
    let mut top = Adding::start(zip, dir, prefix.to_owned())?;
    if let Some(only) = only {
        // A name gone since it was chosen is not there to add.
        top.left = top
            .left
            .filter(|name| only.iter().any(|kept| kept.as_bytes() == name.as_slice()))
            .collect::<Vec<_>>()
            .into_iter();
    }
    let mut stack = vec![top];
    loop {
        let depth = stack.len();
        let Some(current) = stack.last_mut() else {
            break;
        };
        let Some(name) = current.left.next() else {
            stack.pop();
            continue;
        };
        let name = OsStr::from_bytes(&name);
        let Some(text) = name.to_str() else {
            left_out += 1;
            continue;
        };
        if text.starts_with(super::UPLOAD_PREFIX) {
            continue;
        }
        let Ok(stat) = rustix::fs::statat(&current.fd, name, AtFlags::SYMLINK_NOFOLLOW) else {
            left_out += 1;
            continue;
        };
        let path = format!("{}/{}", current.path, entry_name(text));
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::Symlink => {}
            FileType::Directory => {
                if stat.st_dev != disk
                    || depth >= super::MAX_DEPTH
                    || super::mount_root(current.fd.as_fd(), name) == Some(true)
                {
                    left_out += 1;
                    continue;
                }
                let Ok(fd) = rustix::fs::openat(
                    &current.fd,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                ) else {
                    left_out += 1;
                    continue;
                };
                let next = Adding::start(zip, fd, path)?;
                stack.push(next);
            }
            FileType::RegularFile => {
                let Ok(fd) = rustix::fs::openat(
                    &current.fd,
                    name,
                    OFlags::RDONLY
                        | OFlags::NOFOLLOW
                        | OFlags::NONBLOCK
                        | OFlags::NOCTTY
                        | OFlags::CLOEXEC,
                    Mode::empty(),
                ) else {
                    left_out += 1;
                    continue;
                };
                let mut file = File::from(fd);
                let metadata = file.metadata()?;
                // Replaced since it was looked at.
                if !metadata.is_file() {
                    left_out += 1;
                    continue;
                }
                let modified = Utc.timestamp_opt(metadata.mtime(), 0).single();
                let start = {
                    let mut pending = pending.borrow_mut();
                    pending.holding = true;
                    pending.buffer.len()
                };
                // A file past 4 GiB into the archive is ZIP64 too: its offset makes its central
                // record ZIP64, and UnZip then takes its data descriptor to be ZIP64 as well.
                let zip64 = metadata.len() >= ZIP64_FROM
                    || pending.borrow().position() >= u64::from(u32::MAX);
                let started = zip.start_file(
                    &path,
                    options(modified, metadata.permissions().mode(), zip64),
                );
                let mut held = pending.borrow_mut();
                held.holding = false;
                started.map_err(std::io::Error::other)?;
                if zip64 && let Some(header) = held.buffer.get_mut(start..) {
                    zero_zip64_sizes(header);
                }
                drop(held);
                std::io::copy(&mut file, zip)?;
            }
            _ => left_out += 1,
        }
    }
    Ok(left_out)
}

/// The size from which a file is written in ZIP64 form: 4 GiB, less room for deflating to grow
/// what does not compress.
const ZIP64_FROM: u64 = 0xFFFF_FFFF - 16 * 1024 * 1024;

/// How an entry is written, in ZIP64 form only if `zip64`: streamed, the zip crate cannot go back
/// to fill in the sizes that form puts in its local header, and leaves placeholders there that
/// 7-Zip and libarchive refuse, unless [`zero_zip64_sizes`] puts them right.
fn options(modified: Option<chrono::DateTime<Utc>>, mode: u32, zip64: bool) -> SimpleFileOptions {
    let time = modified.and_then(|time| {
        zip::DateTime::from_date_and_time(
            u16::try_from(time.year()).ok()?,
            u8::try_from(time.month()).ok()?,
            u8::try_from(time.day()).ok()?,
            u8::try_from(time.hour()).ok()?,
            u8::try_from(time.minute()).ok()?,
            u8::try_from(time.second()).ok()?,
        )
        .ok()
    });
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(mode & 0o777)
        .large_file(zip64);
    match time {
        Some(time) => options.last_modified_time(time),
        None => options,
    }
}

/// Zeroes the sizes in the ZIP64 field of the local header `header` begins with, as the
/// specification asks of an entry with a data descriptor, which gives them after its data: the
/// zip crate leaves placeholders there for when it can go back, which a stream cannot.
fn zero_zip64_sizes(header: &mut [u8]) {
    let field = |header: &[u8], at: usize| -> Option<usize> {
        let bytes: [u8; 2] = header.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(usize::from(u16::from_le_bytes(bytes)))
    };
    let (Some(flags), Some(name), Some(extra)) =
        (field(header, 6), field(header, 26), field(header, 28))
    else {
        return;
    };
    // Only an entry with a data descriptor gives its sizes later.
    if !header.starts_with(b"PK\x03\x04") || flags & 0x8 == 0 {
        return;
    }
    let mut at = 30 + name;
    let end = at + extra;
    while at + 4 <= end {
        let (Some(id), Some(len)) = (field(header, at), field(header, at + 2)) else {
            return;
        };
        if id == 0x0001 {
            if let Some(sizes) = header.get_mut(at + 4..(at + 4 + len).min(end)) {
                sizes.fill(0);
            }
            return;
        }
        at += 4 + len;
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[tokio::test]
    async fn a_folder_zips_without_its_symlinks_or_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        std::fs::create_dir_all(folder.join("inner")).unwrap();
        std::fs::write(folder.join("a.txt"), "alpha").unwrap();
        std::fs::write(folder.join("inner/b.txt"), "beta").unwrap();
        std::fs::write(dir.path().join("secret"), "keys").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret"), folder.join("link")).unwrap();
        // A named pipe with no writer: reading it would wait for ever.
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            folder.join("pipe"),
            Mode::from_raw_mode(0o600),
        )
        .unwrap();
        std::fs::write(folder.join("back\\slash"), "x").unwrap();
        let fd =
            rustix::fs::open(&folder, OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty()).unwrap();
        let (sender, mut receiver) = mpsc::channel(4);
        let writing =
            tokio::task::spawn_blocking(move || write(fd, "folder".to_owned(), None, sender));
        let mut archive = Vec::new();
        while let Some(chunk) = receiver.recv().await {
            archive.extend_from_slice(&chunk.unwrap());
        }
        writing.await.unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).unwrap();
        let mut names: Vec<String> = zip
            .file_names()
            .map(|name| name.unwrap().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [
            "folder/",
            "folder/a.txt",
            "folder/back_slash",
            "folder/inner/",
            "folder/inner/b.txt"
        ]);
        let mut text = String::new();
        zip.by_name("folder/inner/b.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "beta");
    }

    #[tokio::test]
    async fn only_the_names_chosen_are_zipped() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        std::fs::create_dir_all(folder.join("inner")).unwrap();
        std::fs::write(folder.join("a.txt"), "alpha").unwrap();
        std::fs::write(folder.join("b.txt"), "beta").unwrap();
        std::fs::write(folder.join("inner/c.txt"), "gamma").unwrap();
        let fd =
            rustix::fs::open(&folder, OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty()).unwrap();
        let (sender, mut receiver) = mpsc::channel(4);
        let only = vec!["a.txt".to_owned(), "inner".to_owned(), "gone".to_owned()];
        let writing = tokio::task::spawn_blocking(move || {
            write(fd, "folder".to_owned(), Some(only), sender);
        });
        let mut archive = Vec::new();
        while let Some(chunk) = receiver.recv().await {
            archive.extend_from_slice(&chunk.unwrap());
        }
        writing.await.unwrap();
        let zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).unwrap();
        let mut names: Vec<String> = zip
            .file_names()
            .map(|name| name.unwrap().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [
            "folder/",
            "folder/a.txt",
            "folder/inner/",
            "folder/inner/c.txt"
        ]);
    }

    #[test]
    fn a_zip64_entry_streamed_gives_its_local_sizes_as_zero() {
        let mut archive = Vec::new();
        let mut zip = ZipWriter::new_stream(&mut archive);
        zip.start_file("big.bin", options(None, 0o644, true))
            .unwrap();
        zip.write_all(b"contents").unwrap();
        zip.finish().unwrap();
        // The ZIP64 field follows the local header and its name: the crate leaves placeholders.
        let sizes = 30 + "big.bin".len() + 4;
        assert_eq!(archive.get(sizes - 4..sizes), Some(&[1, 0, 16, 0][..]));
        assert_eq!(archive.get(sizes..sizes + 16), Some(&[0xFF; 16][..]));
        zero_zip64_sizes(&mut archive);
        assert_eq!(archive.get(sizes..sizes + 16), Some(&[0; 16][..]));
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).unwrap();
        let mut text = String::new();
        zip.by_name("big.bin")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "contents");
    }
}
