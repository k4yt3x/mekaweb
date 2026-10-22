//! A folder downloaded as a zip, written as it is read: nothing waits for the whole archive, and
//! nothing of it is kept. Symlinks inside are left out, so a link cannot pull in what is outside
//! the folder; so are named pipes and devices, which have no contents to read, other disks mounted
//! inside, and folders deeper than [`super::MAX_DEPTH`]. What was left out, besides symlinks, is
//! logged.

use std::{
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
};

use bytes::Bytes;
use chrono::{Datelike, TimeZone, Timelike, Utc};
use rustix::fs::{AtFlags, FileType, Mode, OFlags};
use tokio::sync::mpsc;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

/// How many bytes are gathered before they are sent on.
const SEND_BYTES: usize = 256 * 1024;

/// Writes into a channel, a piece at a time.
struct ChannelWriter {
    sender: mpsc::Sender<std::io::Result<Bytes>>,
    buffer: Vec<u8>,
}

impl ChannelWriter {
    fn send(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = Bytes::from(std::mem::take(&mut self.buffer));
        self.sender.blocking_send(Ok(bytes)).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the download stopped")
        })
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= SEND_BYTES {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// Writes the folder `dir` as a zip into `sender`, its entries under `prefix/`. Runs until the
/// archive ends or the download stops.
pub(crate) fn write(dir: OwnedFd, prefix: String, sender: mpsc::Sender<std::io::Result<Bytes>>) {
    let error_sender = sender.clone();
    let writer = ChannelWriter {
        sender,
        buffer: Vec::new(),
    };
    let mut zip = ZipWriter::new_stream(writer);
    let result = add_tree(&mut zip, dir, &entry_name(&prefix)).and_then(|left_out| {
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
        zip.add_directory(format!("{path}/"), options(None, 0o755))
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

/// Adds the folder `dir` and what it holds under `prefix/`; how many entries were left out.
fn add_tree<W: Write>(
    zip: &mut ZipWriter<zip::write::StreamWriter<W>>,
    dir: OwnedFd,
    prefix: &str,
) -> std::io::Result<usize> {
    let disk = rustix::fs::fstat(&dir)?.st_dev;
    let mut left_out = 0;
    let mut stack = vec![Adding::start(zip, dir, prefix.to_owned())?];
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
                zip.start_file(&path, options(modified, metadata.permissions().mode()))
                    .map_err(std::io::Error::other)?;
                std::io::copy(&mut file, zip)?;
            }
            _ => left_out += 1,
        }
    }
    Ok(left_out)
}

fn options(modified: Option<chrono::DateTime<Utc>>, mode: u32) -> SimpleFileOptions {
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
        .large_file(true);
    match time {
        Some(time) => options.last_modified_time(time),
        None => options,
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
        let writing = tokio::task::spawn_blocking(move || write(fd, "folder".to_owned(), sender));
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
}
