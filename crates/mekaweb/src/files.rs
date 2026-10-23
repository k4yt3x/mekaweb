//! Files: browsing, reading, downloading, uploading to and tidying any folder mekaweb's user may
//! reach. Signing in is the boundary: whoever is signed in drives meka's agent and a terminal as
//! that user, so Files keeps no folders of its own. The interface opens it at a session's working
//! directory.
//!
//! Paths are absolute, or start with `~`; `.` and `..` are resolved as written, before the file
//! system sees them. A path's last name is acted on itself: a symlink is listed, moved, trashed or
//! deleted, never what it points to, while the folders leading to it may be symlinks.
//!
//! Files are read only when they are regular files, opened so that a named pipe cannot hold a
//! thread waiting for a writer. Deleting a folder, or zipping one, stays on its disk: a disk
//! mounted inside is left alone, as `rm --one-file-system` would.

pub(crate) mod trash;
pub(crate) mod zip;

use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileExt, MetadataExt},
        },
    },
    path::{Component, Path, PathBuf},
    time::Duration,
};

use axum::http::StatusCode;
use chrono::{DateTime, TimeZone, Utc};
use rustix::fs::{AtFlags, Mode, OFlags, RenameFlags};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    error::ApiError,
    store::{Store, UploadRow},
};

/// The largest piece of an upload sent at once: under Cloudflare's limit on a request, and small
/// enough that a dropped connection loses little.
pub(crate) const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// The most text a preview reads.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// The most bytes looked at to tell text from binary.
const SNIFF_BYTES: usize = 8 * 1024;

/// How long an upload may sit untouched before it is cleared away.
const UPLOAD_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// What an upload's file is called until it is finished, before its id.
const UPLOAD_PREFIX: &str = ".mekaweb-upload-";

/// The largest upload: as much as a file may hold.
const MAX_UPLOAD_BYTES: u64 = i64::MAX as u64;

/// The deepest a deletion or a zip goes into folders within folders.
pub(crate) const MAX_DEPTH: usize = 256;

/// Why a Files operation failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FilesError {
    #[error("{0}")]
    BadPath(String),
    #[error("{0} is not there")]
    NotFound(String),
    #[error("{0} is there already")]
    Exists(String),
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NoTrash(String),
    #[error(transparent)]
    Io(std::io::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl FilesError {
    /// An I/O error about `what`, told apart where it says something people can act on.
    pub(crate) fn io(error: std::io::Error, what: &str) -> Self {
        match error.raw_os_error() {
            Some(libc::ENOENT) => Self::NotFound(what.to_owned()),
            Some(libc::EEXIST) => Self::Exists(what.to_owned()),
            Some(libc::ENOTEMPTY) => Self::Conflict(format!("{what} is not empty")),
            Some(libc::EBUSY) => {
                Self::Refused(format!("{what} is in use, or a disk is mounted there"))
            }
            Some(libc::EACCES | libc::EPERM) => {
                Self::Refused(format!("mekaweb is not allowed to do that to {what}"))
            }
            Some(libc::EXDEV) => Self::Conflict(format!(
                "{what} is on another disk; download and upload it instead"
            )),
            Some(libc::ENOTDIR) => Self::BadPath(format!("a part of {what} is not a folder")),
            Some(libc::EISDIR) => Self::BadPath(format!("{what} is a folder")),
            Some(libc::ELOOP) => Self::BadPath(format!("{what} leads through too many symlinks")),
            Some(libc::ENAMETOOLONG) => Self::BadPath(format!("the name of {what} is too long")),
            Some(libc::EINVAL) => Self::BadPath(format!("that cannot be done to {what}")),
            Some(libc::ENOSPC) => Self::Refused("the disk is full".to_owned()),
            Some(libc::EROFS) => Self::Refused(format!("{what} is on a read-only disk")),
            _ => Self::Io(error),
        }
    }
}

impl From<FilesError> for ApiError {
    fn from(error: FilesError) -> Self {
        match error {
            FilesError::NotFound(_) => Self::not_found(error.to_string()),
            FilesError::BadPath(_) => Self::bad_request(error.to_string()),
            FilesError::Exists(_) | FilesError::Conflict(_) => Self::conflict(error.to_string()),
            FilesError::NoTrash(_) => Self::new(
                StatusCode::CONFLICT,
                "no-trash",
                "No trash there",
                error.to_string(),
            ),
            FilesError::Refused(_) => Self::new(
                StatusCode::FORBIDDEN,
                "refused",
                "Not allowed",
                error.to_string(),
            ),
            FilesError::Io(error) => Self::internal(&anyhow::Error::from(error)),
            FilesError::Internal(error) => Self::internal(&error),
        }
    }
}

/// `path` as Files takes it: absolute, or from the home folder with `~`, its `.` and `..` resolved
/// as written. Nothing is trimmed: a name may begin or end with a space.
pub(crate) fn resolve(path: &str) -> Result<PathBuf, FilesError> {
    if path.contains('\0') {
        return Err(FilesError::BadPath("a path cannot hold a NUL".to_owned()));
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            crate::config::home()?.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err(FilesError::BadPath(
            "give an absolute path, or one starting with ~/".to_owned(),
        ));
    }
    let mut resolved = PathBuf::from("/");
    for component in expanded.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    Ok(resolved)
}

/// `path`'s folder and last name; the root folder has neither.
fn split(path: &Path) -> Result<(&Path, &OsStr), FilesError> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => Ok((parent, name)),
        _ => Err(FilesError::BadPath(
            "the root folder itself cannot be changed".to_owned(),
        )),
    }
}

/// `path` as people read it.
fn shown(path: &Path) -> String {
    path.display().to_string()
}

/// Opens the folder `path`, its symlinks followed.
fn open_dir(path: &Path, flags: OFlags) -> Result<OwnedFd, FilesError> {
    rustix::fs::open(
        path,
        flags | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| FilesError::io(error.into(), &shown(path)))
}

/// Checks a name for a new file or folder, taken as it is written.
pub(crate) fn check_name(name: &OsStr) -> Result<&OsStr, FilesError> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." {
        return Err(FilesError::BadPath(
            "a name cannot be empty, . or ..".to_owned(),
        ));
    }
    if bytes.contains(&b'/') || bytes.contains(&0) {
        return Err(FilesError::BadPath(
            "a name cannot hold a / or a NUL".to_owned(),
        ));
    }
    if bytes.len() > 255 {
        return Err(FilesError::BadPath(
            "a name is at most 255 bytes".to_owned(),
        ));
    }
    if bytes.starts_with(UPLOAD_PREFIX.as_bytes()) {
        return Err(FilesError::BadPath(format!(
            "a name cannot start with {UPLOAD_PREFIX}, which unfinished uploads use"
        )));
    }
    Ok(name)
}

/// What an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    File,
    Folder,
    Symlink,
    Other,
}

impl Kind {
    fn of(metadata: &Metadata) -> Self {
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            Self::Symlink
        } else if file_type.is_dir() {
            Self::Folder
        } else if file_type.is_file() {
            Self::File
        } else {
            Self::Other
        }
    }

    fn of_stat(stat: &rustix::fs::Stat) -> Self {
        match rustix::fs::FileType::from_raw_mode(stat.st_mode) {
            rustix::fs::FileType::Symlink => Self::Symlink,
            rustix::fs::FileType::Directory => Self::Folder,
            rustix::fs::FileType::RegularFile => Self::File,
            _ => Self::Other,
        }
    }
}

/// An entry in a folder.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) kind: Kind,
    /// Its size in bytes; a folder's is what the file system says of it.
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
    /// Its permissions, as `ls` writes them: `rwxr-xr-x`.
    pub(crate) permissions: String,
    /// Where a symlink points, as written.
    pub(crate) target: Option<String>,
    /// What a symlink leads to, if anything.
    pub(crate) target_kind: Option<Kind>,
    /// Whether its name starts with a dot.
    pub(crate) hidden: bool,
}

/// A folder's entries.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Listing {
    /// The folder, absolute.
    pub(crate) path: String,
    pub(crate) entries: Vec<Entry>,
    /// The home folder, absolute, which `~` names; none where it is not known.
    pub(crate) home: Option<String>,
}

/// A text file's contents, for a preview.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Text {
    pub(crate) text: String,
    /// The file's size.
    pub(crate) size: u64,
    /// Whether the file is longer than what was read.
    pub(crate) truncated: bool,
    /// Whether the file looks binary, in which case `text` is empty.
    pub(crate) binary: bool,
}

/// A file opened for download.
pub(crate) struct Download {
    pub(crate) file: File,
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
    pub(crate) name: String,
}

/// An upload's state.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct UploadView {
    pub(crate) id: String,
    /// How many bytes have arrived.
    pub(crate) offset: u64,
    /// How many bytes it is.
    pub(crate) size: u64,
    /// The most bytes a piece may hold.
    pub(crate) chunk_bytes: u64,
}

/// Files, with unfinished uploads kept in the store.
pub(crate) struct Files {
    store: Store,
    /// The home folder's trash, if there is a home folder.
    home_trash: Option<PathBuf>,
}

impl Files {
    /// Files, with uploads kept in `store`.
    pub(crate) fn new(store: Store) -> Self {
        Self {
            store,
            home_trash: trash::home_trash().ok(),
        }
    }

    fn home_trash(&self) -> Result<PathBuf, FilesError> {
        self.home_trash.clone().ok_or_else(|| {
            FilesError::Refused("there is no home folder to keep a trash in".to_owned())
        })
    }

    /// Lists the folder `path`.
    pub(crate) async fn list(&self, path: PathBuf) -> Result<Listing, FilesError> {
        blocking(move || {
            let dir = open_dir(&path, OFlags::RDONLY)?;
            let mut entries = Vec::new();
            for item in rustix::fs::Dir::read_from(&dir)
                .map_err(|error| FilesError::io(error.into(), &shown(&path)))?
            {
                let item = item.map_err(|error| FilesError::io(error.into(), &shown(&path)))?;
                let name = OsStr::from_bytes(item.file_name().to_bytes());
                if name == "."
                    || name == ".."
                    || name.as_bytes().starts_with(UPLOAD_PREFIX.as_bytes())
                {
                    continue;
                }
                let Some(name) = name.to_str() else {
                    // A name that is not UTF-8 cannot be named back in a request.
                    continue;
                };
                match entry(dir.as_fd(), name) {
                    Ok(entry) => entries.push(entry),
                    // Gone between reading the folder and looking at it.
                    Err(FilesError::NotFound(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(Listing {
                path: shown(&path),
                entries,
                home: resolve("~").ok().map(|home| shown(&home)),
            })
        })
        .await
    }

    /// Reads a text file for a preview.
    pub(crate) async fn text(&self, path: PathBuf) -> Result<Text, FilesError> {
        blocking(move || {
            let (mut file, metadata) = open_regular(&path)?;
            let size = metadata.len();
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_TEXT_BYTES)
                .read_to_end(&mut bytes)
                .map_err(|error| FilesError::io(error, &shown(&path)))?;
            let truncated = size > bytes.len() as u64;
            let sniffed = bytes.get(..SNIFF_BYTES).unwrap_or(&bytes);
            let binary = sniffed.contains(&0);
            let text = if binary {
                String::new()
            } else {
                match String::from_utf8(bytes) {
                    Ok(text) => text,
                    // Cut at the limit in the middle of a character, or not UTF-8 at all.
                    Err(error) => {
                        let valid = error.utf8_error().valid_up_to();
                        let bytes = error.into_bytes();
                        if truncated && bytes.len() - valid < 4 {
                            String::from_utf8_lossy(bytes.get(..valid).unwrap_or_default())
                                .into_owned()
                        } else {
                            return Ok(Text {
                                text: String::new(),
                                size,
                                truncated,
                                binary: true,
                            });
                        }
                    }
                }
            };
            Ok(Text {
                text,
                size,
                truncated,
                binary,
            })
        })
        .await
    }

    /// Opens a file to download.
    pub(crate) async fn open_file(&self, path: PathBuf) -> Result<Download, FilesError> {
        blocking(move || {
            let (file, metadata) = open_regular(&path)?;
            Ok(Download {
                size: metadata.len(),
                modified: modified(&metadata),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                file,
            })
        })
        .await
    }

    /// Opens a folder to download as a zip.
    pub(crate) async fn open_folder(&self, path: PathBuf) -> Result<OwnedFd, FilesError> {
        blocking(move || open_dir(&path, OFlags::RDONLY)).await
    }

    /// Makes the folder `path`, and with `parents` any folders above it that are missing.
    pub(crate) async fn make_folder(
        &self,
        path: PathBuf,
        parents: bool,
    ) -> Result<Entry, FilesError> {
        blocking(move || {
            let (parent, name) = split(&path)?;
            let name = check_name(name)?.to_owned();
            if parents {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .create(parent)
                    .map_err(|error| FilesError::io(error, &shown(parent)))?;
            }
            let dir = open_dir(parent, OFlags::PATH)?;
            rustix::fs::mkdirat(&dir, &name, Mode::from_raw_mode(0o777)).or_else(|error| {
                // Asked for with its parents, a folder that is there already is made, as with
                // `mkdir -p`; anything else there is not a folder made.
                let folder = || {
                    rustix::fs::statat(&dir, &name, AtFlags::empty()).is_ok_and(|stat| {
                        rustix::fs::FileType::from_raw_mode(stat.st_mode)
                            == rustix::fs::FileType::Directory
                    })
                };
                if parents && error == rustix::io::Errno::EXIST && folder() {
                    Ok(())
                } else {
                    Err(FilesError::io(error.into(), &shown(&path)))
                }
            })?;
            entry(dir.as_fd(), &name.to_string_lossy())
        })
        .await
    }

    /// Moves `from` to `to`, never over something already there.
    pub(crate) async fn move_entry(&self, from: PathBuf, to: PathBuf) -> Result<(), FilesError> {
        if from == to {
            return Err(FilesError::BadPath("it is there already".to_owned()));
        }
        if to.starts_with(&from) {
            return Err(FilesError::BadPath(
                "a folder cannot move inside itself".to_owned(),
            ));
        }
        blocking(move || {
            let (from_parent, from_name) = split(&from)?;
            let (to_parent, to_name) = split(&to)?;
            let to_name = check_name(to_name)?;
            let source = open_dir(from_parent, OFlags::PATH)?;
            let target = open_dir(to_parent, OFlags::PATH)?;
            rustix::fs::renameat_with(&source, from_name, &target, to_name, RenameFlags::NOREPLACE)
                .map_err(|error| match error.raw_os_error() {
                    libc::EEXIST => FilesError::Exists(shown(&to)),
                    _ => FilesError::io(error.into(), &shown(&from)),
                })
        })
        .await
    }

    /// Deletes `path` for good, and everything in it.
    pub(crate) async fn delete(&self, path: PathBuf) -> Result<(), FilesError> {
        blocking(move || {
            let (parent, name) = split(&path)?;
            let dir = open_dir(parent, OFlags::PATH)?;
            if is_mount(dir.as_fd(), name)? {
                return Err(FilesError::Refused(format!(
                    "{} is another disk, mounted there; unmount it rather than delete it",
                    shown(&path)
                )));
            }
            remove_tree(dir.as_fd(), name)
        })
        .await
    }

    /// Moves `path` to the trash on its disk.
    pub(crate) async fn trash(&self, path: PathBuf) -> Result<(), FilesError> {
        let home = self.home_trash()?;
        blocking(move || {
            let (parent, name) = split(&path)?;
            let dir = open_dir(parent, OFlags::PATH)?;
            if is_mount(dir.as_fd(), name)? {
                return Err(FilesError::NoTrash(format!(
                    "{} is a disk mounted there, which no trash can hold",
                    shown(&path)
                )));
            }
            trash::trash(&home, dir.as_fd(), name, &path)
        })
        .await
    }

    /// What the trashes hold.
    pub(crate) async fn trashed(&self) -> Result<Vec<trash::Trashed>, FilesError> {
        let home = self.home_trash()?;
        blocking(move || Ok(trash::list(&home))).await
    }

    /// Puts the trashed item `id` back where it was.
    pub(crate) async fn restore(&self, id: &str) -> Result<(), FilesError> {
        let id = id.to_owned();
        let home = self.home_trash()?;
        blocking(move || {
            let item = trash::find(&home, &id)?;
            let original = item.original.clone();
            let plain = original.is_absolute()
                && !original
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir));
            if !plain {
                return Err(FilesError::BadPath(
                    "the trash does not say plainly where it was".to_owned(),
                ));
            }
            let (parent, name) = split(&original)?;
            let dir = open_dir(parent, OFlags::PATH)?;
            trash::restore(&item, dir.as_fd(), name)
        })
        .await
    }

    /// Deletes the trashed item `id` for good.
    pub(crate) async fn purge(&self, id: &str) -> Result<(), FilesError> {
        let id = id.to_owned();
        let home = self.home_trash()?;
        blocking(move || {
            let item = trash::find(&home, &id)?;
            trash::purge(&item)
        })
        .await
    }

    /// Starts uploading `name`, of `size` bytes, into the folder `dir`; unless `replace`, not over
    /// a file of that name.
    pub(crate) async fn start_upload(
        &self,
        dir: PathBuf,
        name: &str,
        size: u64,
        replace: bool,
    ) -> Result<UploadView, FilesError> {
        let name = check_name(OsStr::new(name))?.to_string_lossy().into_owned();
        if size > MAX_UPLOAD_BYTES {
            return Err(FilesError::BadPath("that is too large a file".to_owned()));
        }
        let id = Uuid::new_v4().to_string();
        let temp = format!("{UPLOAD_PREFIX}{id}");
        let folder_path = dir.clone();
        let created = temp.clone();
        let checked = name.clone();
        let folder = blocking(move || {
            let folder = open_dir(&folder_path, OFlags::PATH)?;
            if !replace
                && rustix::fs::statat(&folder, checked.as_str(), AtFlags::SYMLINK_NOFOLLOW).is_ok()
            {
                return Err(FilesError::Exists(checked));
            }
            // Only its owner reads it while it arrives; it takes its proper mode when finished.
            rustix::fs::openat(
                &folder,
                created.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|error| FilesError::io(error.into(), &created))?;
            Ok(folder)
        })
        .await?;
        let row = UploadRow {
            id: id.clone(),
            dir: shown(&dir),
            name,
            size,
            temp: temp.clone(),
            active_at: Utc::now(),
        };
        if let Err(error) = self.store.add_upload(&row).await {
            if let Err(error) = rustix::fs::unlinkat(&folder, temp.as_str(), AtFlags::empty()) {
                tracing::warn!("could not remove an upload that did not start: {error}");
            }
            return Err(error.into());
        }
        Ok(UploadView {
            id,
            offset: 0,
            size,
            chunk_bytes: MAX_CHUNK_BYTES as u64,
        })
    }

    async fn upload_row(&self, id: &str) -> Result<UploadRow, FilesError> {
        self.store
            .upload(id)
            .await?
            .ok_or_else(|| FilesError::NotFound("the upload".to_owned()))
    }

    /// Opens an upload's unfinished file, which must be a regular file of its own.
    fn open_upload(row: &UploadRow, flags: OFlags) -> Result<File, FilesError> {
        let folder = open_dir(Path::new(&row.dir), OFlags::PATH)?;
        let file = File::from(
            rustix::fs::openat(
                &folder,
                row.temp.as_str(),
                flags | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| FilesError::io(error.into(), "the upload"))?,
        );
        let metadata = file
            .metadata()
            .map_err(|error| FilesError::io(error, "the upload"))?;
        if !metadata.is_file() {
            return Err(FilesError::Conflict(
                "the upload's file was replaced".to_owned(),
            ));
        }
        Ok(file)
    }

    /// How far the upload `id` is.
    pub(crate) async fn upload_status(&self, id: &str) -> Result<UploadView, FilesError> {
        let row = self.upload_row(id).await?;
        let size = row.size;
        let (id, offset) = blocking(move || {
            let file = Self::open_upload(&row, OFlags::RDONLY)?;
            let offset = file
                .metadata()
                .map_err(|error| FilesError::io(error, "the upload"))?
                .len();
            Ok((row.id, offset))
        })
        .await?;
        Ok(UploadView {
            id,
            offset,
            size,
            chunk_bytes: MAX_CHUNK_BYTES as u64,
        })
    }

    /// Writes `bytes` at `offset` of the upload `id`, which must be where it stands.
    pub(crate) async fn write_chunk(
        &self,
        id: &str,
        offset: u64,
        bytes: bytes::Bytes,
    ) -> Result<UploadView, FilesError> {
        let row = self.upload_row(id).await?;
        let size = row.size;
        let upload = row.clone();
        let written = blocking(move || {
            let file = Self::open_upload(&upload, OFlags::WRONLY)?;
            let current = file
                .metadata()
                .map_err(|error| FilesError::io(error, "the upload"))?
                .len();
            if current != offset {
                return Err(FilesError::Conflict(format!(
                    "the upload stands at {current} bytes, not {offset}"
                )));
            }
            if offset + bytes.len() as u64 > size {
                return Err(FilesError::BadPath(
                    "that is more than the upload's size".to_owned(),
                ));
            }
            file.write_all_at(&bytes, offset)
                .map_err(|error| FilesError::io(error, "the upload"))?;
            Ok(offset + bytes.len() as u64)
        })
        .await?;
        self.store.touch_upload(&row.id).await?;
        Ok(UploadView {
            id: row.id,
            offset: written,
            size,
            chunk_bytes: MAX_CHUNK_BYTES as u64,
        })
    }

    /// Puts a whole upload in its place, over a file of the same name if `replace`.
    pub(crate) async fn finish_upload(&self, id: &str, replace: bool) -> Result<Entry, FilesError> {
        let row = self.upload_row(id).await?;
        let finished = row.clone();
        let entry = blocking(move || {
            let folder = open_dir(Path::new(&finished.dir), OFlags::PATH)?;
            // The upload as opened, never through a symlink put in its place, is checked and
            // given its mode through that one handle.
            let upload = rustix::fs::openat(
                &folder,
                finished.temp.as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| FilesError::io(error.into(), "the upload"))?;
            let metadata = rustix::fs::fstat(&upload)
                .map_err(|error| FilesError::io(error.into(), "the upload"))?;
            if rustix::fs::FileType::from_raw_mode(metadata.st_mode)
                != rustix::fs::FileType::RegularFile
            {
                return Err(FilesError::Conflict("the upload is not a file".to_owned()));
            }
            let have = u64::try_from(metadata.st_size).unwrap_or_default();
            if have != finished.size {
                return Err(FilesError::Conflict(format!(
                    "the upload has {have} of its {} bytes",
                    finished.size
                )));
            }
            // A file replaced keeps its mode; a new one takes the one new files get.
            let mode =
                rustix::fs::statat(&folder, finished.name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                    .ok()
                    .filter(|_| replace)
                    .filter(|existing| {
                        rustix::fs::FileType::from_raw_mode(existing.st_mode)
                            == rustix::fs::FileType::RegularFile
                    })
                    .map_or_else(new_file_mode, |existing| existing.st_mode & 0o7777);
            rustix::fs::fchmod(&upload, Mode::from_raw_mode(mode))
                .map_err(|error| FilesError::io(error.into(), "the upload"))?;
            drop(upload);
            let flags = if replace {
                RenameFlags::empty()
            } else {
                RenameFlags::NOREPLACE
            };
            rustix::fs::renameat_with(
                &folder,
                finished.temp.as_str(),
                &folder,
                finished.name.as_str(),
                flags,
            )
            .map_err(|error| FilesError::io(error.into(), &finished.name))?;
            entry(folder.as_fd(), &finished.name)
        })
        .await?;
        self.store.delete_upload(&row.id).await?;
        Ok(entry)
    }

    /// Stops the upload `id` and removes what it wrote.
    pub(crate) async fn cancel_upload(&self, id: &str) -> Result<(), FilesError> {
        let row = self.upload_row(id).await?;
        self.discard_upload(&row).await
    }

    async fn discard_upload(&self, row: &UploadRow) -> Result<(), FilesError> {
        let dir = PathBuf::from(&row.dir);
        let temp = row.temp.clone();
        let removed = blocking(move || {
            let folder = open_dir(&dir, OFlags::PATH)?;
            match rustix::fs::unlinkat(&folder, temp.as_str(), AtFlags::empty()) {
                Ok(()) => Ok(()),
                Err(error) if error == rustix::io::Errno::NOENT => Ok(()),
                Err(error) => Err(FilesError::io(error.into(), "the upload")),
            }
        })
        .await;
        if let Err(error) = removed {
            tracing::warn!("could not remove an unfinished upload: {error}");
        }
        self.store.delete_upload(&row.id).await?;
        Ok(())
    }

    /// Clears away uploads left untouched for a day.
    pub(crate) async fn sweep_uploads(&self) -> anyhow::Result<()> {
        let cutoff = Utc::now() - chrono::Duration::from_std(UPLOAD_LIFETIME)?;
        for row in self.store.uploads_before(cutoff).await? {
            if let Err(error) = self.discard_upload(&row).await {
                tracing::warn!("could not clear an abandoned upload: {error}");
            }
        }
        Ok(())
    }
}

/// Runs blocking file system work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FilesError> + Send + 'static,
) -> Result<T, FilesError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| FilesError::Internal(anyhow::anyhow!("a file task failed: {error}")))?
}

/// The entry `name` in the folder `dir`, a symlink as itself.
fn entry(dir: BorrowedFd<'_>, name: &str) -> Result<Entry, FilesError> {
    let stat = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| FilesError::io(error.into(), name))?;
    let kind = Kind::of_stat(&stat);
    let (target, target_kind) = if kind == Kind::Symlink {
        let target = rustix::fs::readlinkat(dir, name, Vec::new())
            .ok()
            .map(|target| target.to_string_lossy().into_owned());
        let followed = rustix::fs::statat(dir, name, AtFlags::empty())
            .ok()
            .map(|stat| Kind::of_stat(&stat));
        (target, followed)
    } else {
        (None, None)
    };
    let nanos = u32::try_from(stat.st_mtime_nsec).unwrap_or_default();
    Ok(Entry {
        name: name.to_owned(),
        kind,
        size: u64::try_from(stat.st_size).unwrap_or_default(),
        modified: Utc.timestamp_opt(stat.st_mtime, nanos).single(),
        permissions: permissions(stat.st_mode),
        target,
        target_kind,
        hidden: name.starts_with('.'),
    })
}

/// When `metadata` says its file was last changed.
fn modified(metadata: &Metadata) -> Option<DateTime<Utc>> {
    let nanos = u32::try_from(metadata.mtime_nsec()).unwrap_or_default();
    Utc.timestamp_opt(metadata.mtime(), nanos).single()
}

/// Permission bits as `ls` writes them.
fn permissions(mode: u32) -> String {
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    bits.iter()
        .map(|(bit, letter)| if mode & bit != 0 { *letter } else { '-' })
        .collect()
}

/// Opens `path` to read, if it is a regular file. It is looked at before it is opened to read, so
/// neither a named pipe nor a device, which can act on being opened, is.
fn open_regular(path: &Path) -> Result<(File, Metadata), FilesError> {
    let handle = rustix::fs::open(path, OFlags::PATH | OFlags::CLOEXEC, Mode::empty())
        .map_err(|error| FilesError::io(error.into(), &shown(path)))?;
    let stat =
        rustix::fs::fstat(&handle).map_err(|error| FilesError::io(error.into(), &shown(path)))?;
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile {
        return Err(FilesError::BadPath(format!(
            "{} is not a file",
            shown(path)
        )));
    }
    // Opened again through the handle: the file looked at, whatever the path names by now.
    let fd = rustix::fs::open(
        format!("/proc/self/fd/{}", handle.as_raw_fd()),
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| FilesError::io(error.into(), &shown(path)))?;
    let file = File::from(fd);
    let metadata = file
        .metadata()
        .map_err(|error| FilesError::io(error, &shown(path)))?;
    if !metadata.is_file() {
        return Err(FilesError::BadPath(format!(
            "{} is not a file",
            shown(path)
        )));
    }
    Ok((file, metadata))
}

/// The device the file `fd` is open on is on.
fn device(fd: BorrowedFd<'_>) -> Result<u64, FilesError> {
    rustix::fs::fstat(fd)
        .map(|stat| stat.st_dev)
        .map_err(|error| FilesError::io(error.into(), "the folder"))
}

/// Whether `name` in `dir` is a mount point: another disk, or a bind mount, which is on the same
/// disk and so cannot be told by its device.
pub(crate) fn is_mount(dir: BorrowedFd<'_>, name: &OsStr) -> Result<bool, FilesError> {
    if let Some(root) = mount_root(dir, name) {
        return Ok(root);
    }
    let item = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| FilesError::io(error.into(), &name.to_string_lossy()))?;
    Ok(item.st_dev != device(dir)?)
}

/// Whether `name` in `dir` is the root of a mount, where the kernel says (Linux 5.8 on).
pub(crate) fn mount_root(dir: BorrowedFd<'_>, name: &OsStr) -> Option<bool> {
    let stat = rustix::fs::statx(
        dir,
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

/// The mode a new file gets: read and write for all, less the process's umask.
fn new_file_mode() -> u32 {
    let umask = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("Umask:"))
                .and_then(|value| u32::from_str_radix(value.trim(), 8).ok())
        })
        .unwrap_or(0o022);
    0o666 & !umask
}

/// A folder being removed: what it is called in its parent, and the names in it left to remove.
struct Removing {
    fd: OwnedFd,
    name: Vec<u8>,
    left: Vec<Vec<u8>>,
}

impl Removing {
    fn open(dir: BorrowedFd<'_>, name: &[u8]) -> Result<Self, FilesError> {
        let shown = String::from_utf8_lossy(name).into_owned();
        let fd = rustix::fs::openat(
            dir,
            OsStr::from_bytes(name),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| FilesError::io(error.into(), &shown))?;
        // A folder that cannot be read to its end is not removed: what was missed would stay.
        let left = rustix::fs::Dir::read_from(&fd)
            .map_err(|error| FilesError::io(error.into(), &shown))?
            .map(|item| item.map(|item| item.file_name().to_bytes().to_vec()))
            .filter(|item| !matches!(item.as_deref(), Ok(b".") | Ok(b"..")))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| FilesError::io(error.into(), &shown))?;
        Ok(Self {
            fd,
            name: name.to_vec(),
            left,
        })
    }
}

/// Removes `name` in `dir`, and everything in it, without following a symlink, and without
/// going into another disk mounted inside: what is on one is left, and the folders holding it.
pub(crate) fn remove_tree(dir: BorrowedFd<'_>, name: &OsStr) -> Result<(), FilesError> {
    let shown = |name: &[u8]| String::from_utf8_lossy(name).into_owned();
    let top = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| FilesError::io(error.into(), &shown(name.as_bytes())))?;
    if rustix::fs::FileType::from_raw_mode(top.st_mode) != rustix::fs::FileType::Directory {
        return rustix::fs::unlinkat(dir, name, AtFlags::empty())
            .map_err(|error| FilesError::io(error.into(), &shown(name.as_bytes())));
    }
    let disk = top.st_dev;
    let mut mounts_left = false;
    let mut stack = vec![Removing::open(dir, name.as_bytes())?];
    loop {
        let depth = stack.len();
        let Some(current) = stack.last_mut() else {
            break;
        };
        let Some(item) = current.left.pop() else {
            let Some(done) = stack.pop() else {
                break;
            };
            let parent = stack.last().map_or(dir, |parent| parent.fd.as_fd());
            match rustix::fs::unlinkat(parent, OsStr::from_bytes(&done.name), AtFlags::REMOVEDIR) {
                Ok(()) => {}
                // What holds a mounted disk stays.
                Err(error) if mounts_left && error == rustix::io::Errno::NOTEMPTY => {}
                Err(error) => return Err(FilesError::io(error.into(), &shown(&done.name))),
            }
            continue;
        };
        let stat = match rustix::fs::statat(
            &current.fd,
            OsStr::from_bytes(&item),
            AtFlags::SYMLINK_NOFOLLOW,
        ) {
            Ok(stat) => stat,
            Err(error) if error == rustix::io::Errno::NOENT => continue,
            Err(error) => return Err(FilesError::io(error.into(), &shown(&item))),
        };
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::Directory {
            rustix::fs::unlinkat(&current.fd, OsStr::from_bytes(&item), AtFlags::empty())
                .map_err(|error| FilesError::io(error.into(), &shown(&item)))?;
            continue;
        }
        if stat.st_dev != disk
            || mount_root(current.fd.as_fd(), OsStr::from_bytes(&item)) == Some(true)
        {
            mounts_left = true;
            continue;
        }
        if depth >= MAX_DEPTH {
            return Err(FilesError::Refused(format!(
                "{} holds folders more than {MAX_DEPTH} deep; delete it from a terminal",
                shown(name.as_bytes())
            )));
        }
        let next = Removing::open(current.fd.as_fd(), &item)?;
        stack.push(next);
    }
    if mounts_left {
        return Err(FilesError::Refused(format!(
            "another disk is mounted inside {}; it and the folders holding it were left",
            shown(name.as_bytes())
        )));
    }
    Ok(())
}

/// Reads part of `file` from `start`, `length` bytes long.
pub(crate) fn range_reader(mut file: File, start: u64, length: u64) -> std::io::Result<impl Read> {
    file.seek(SeekFrom::Start(start))?;
    Ok(file.take(length))
}

/// What a `Range` header asks of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Range {
    /// The whole file: no range, or none this server serves, which it may ignore.
    Whole,
    /// `length` bytes from `start`.
    Part { start: u64, length: u64 },
    /// A range wholly past the file's end.
    Unsatisfiable,
}

/// What the `Range` header `header` asks of a file of `size` bytes. One byte range is served;
/// another unit, several ranges, or a range that cannot be read are ignored, as RFC 9110 allows.
pub(crate) fn parse_range(header: &str, size: u64) -> Range {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return Range::Whole;
    };
    if spec.contains(',') {
        return Range::Whole;
    }
    let Some((start, end)) = spec.split_once('-') else {
        return Range::Whole;
    };
    let number = |text: &str| text.parse::<u64>().ok();
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return Range::Whole,
        ("", suffix) => match number(suffix) {
            None => return Range::Whole,
            Some(0) => return Range::Unsatisfiable,
            Some(suffix) => (size.saturating_sub(suffix), size.checked_sub(1)),
        },
        (start, "") => match number(start) {
            None => return Range::Whole,
            Some(start) => (start, size.checked_sub(1)),
        },
        (start, end) => match (number(start), number(end)) {
            (Some(start), Some(end)) if start <= end => {
                (start, size.checked_sub(1).map(|last| end.min(last)))
            }
            _ => return Range::Whole,
        },
    };
    match end {
        Some(end) if start < size => Range::Part {
            start,
            length: end - start + 1,
        },
        _ => Range::Unsatisfiable,
    }
}

/// Writes `text` to a new file `name` in `dir`, for tests and the trash's info files.
pub(crate) fn write_new(dir: BorrowedFd<'_>, name: &str, text: &[u8]) -> std::io::Result<()> {
    let fd = rustix::fs::openat(
        dir,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )?;
    let mut file = File::from(fd);
    file.write_all(text)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    fn files() -> Files {
        Files::new(Store::in_memory().unwrap())
    }

    #[test]
    fn paths_are_absolute_with_their_dots_resolved() {
        assert_eq!(resolve("/a/b/").unwrap(), Path::new("/a/b"));
        assert_eq!(resolve("/a/./b/../c").unwrap(), Path::new("/a/c"));
        assert_eq!(resolve("/../..").unwrap(), Path::new("/"));
        assert_eq!(
            resolve("~/x").unwrap(),
            crate::config::home().unwrap().join("x")
        );
        assert_eq!(resolve("~").unwrap(), crate::config::home().unwrap());
        assert_eq!(
            resolve("/a/report ").unwrap(),
            Path::new("/a/report "),
            "a name's spaces are its own"
        );
        for bad in ["relative", "~user/x", "", " /a", "/a\0b"] {
            assert!(resolve(bad).is_err(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn a_symlink_is_listed_as_itself_and_acted_on_as_itself() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(dir.path().join("secret"), "keys").unwrap();
        symlink(dir.path().join("secret"), work.join("link")).unwrap();
        let files = files();
        let listing = files.list(work.clone()).await.unwrap();
        let link = &listing.entries[0];
        assert_eq!(link.kind, Kind::Symlink);
        assert_eq!(link.target_kind, Some(Kind::File));
        files.delete(work.join("link")).await.unwrap();
        assert!(
            dir.path().join("secret").exists(),
            "the link went, not what it led to"
        );
    }

    #[tokio::test]
    async fn text_previews_tell_binary_and_long_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        std::fs::write(dir.path().join("b.bin"), [0_u8, 1, 2]).unwrap();
        let files = files();
        let text = files.text(dir.path().join("a.txt")).await.unwrap();
        assert_eq!(text.text, "hello");
        assert!(!text.binary);
        assert!(files.text(dir.path().join("b.bin")).await.unwrap().binary);
        assert!(matches!(
            files.text(dir.path().to_path_buf()).await,
            Err(FilesError::BadPath(_))
        ));
    }

    #[tokio::test]
    async fn moves_never_replace_and_folders_stay_out_of_themselves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        std::fs::create_dir_all(path.join("a/b")).unwrap();
        std::fs::write(path.join("x"), "x").unwrap();
        std::fs::write(path.join("y"), "y").unwrap();
        let files = files();
        assert!(matches!(
            files.move_entry(path.join("x"), path.join("y")).await,
            Err(FilesError::Exists(_))
        ));
        assert!(matches!(
            files.move_entry(path.join("a"), path.join("a/b/a")).await,
            Err(FilesError::BadPath(_))
        ));
        files
            .move_entry(path.join("x"), path.join("a/b/z"))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(path.join("a/b/z")).unwrap(), "x");
    }

    #[tokio::test]
    async fn a_folder_is_made_with_or_without_its_parents() {
        let dir = tempfile::tempdir().unwrap();
        let files = files();
        let made = files
            .make_folder(dir.path().join("one"), false)
            .await
            .unwrap();
        assert_eq!(made.kind, Kind::Folder);
        assert!(matches!(
            files.make_folder(dir.path().join("one"), false).await,
            Err(FilesError::Exists(_))
        ));
        assert!(
            files
                .make_folder(dir.path().join("p/q"), false)
                .await
                .is_err()
        );
        files
            .make_folder(dir.path().join("p/q"), true)
            .await
            .unwrap();
        files
            .make_folder(dir.path().join("p/q"), true)
            .await
            .unwrap();
        assert!(dir.path().join("p/q").is_dir());
    }

    #[tokio::test]
    async fn an_upload_resumes_where_it_stands_and_lands_whole() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().to_path_buf();
        let files = files();
        let upload = files
            .start_upload(work.clone(), "data.bin", 6, false)
            .await
            .unwrap();
        assert!(
            files.list(work.clone()).await.unwrap().entries.is_empty(),
            "an unfinished upload is not listed"
        );
        files
            .write_chunk(&upload.id, 0, bytes::Bytes::from_static(b"abc"))
            .await
            .unwrap();
        assert!(matches!(
            files
                .write_chunk(&upload.id, 0, bytes::Bytes::from_static(b"abc"))
                .await,
            Err(FilesError::Conflict(_))
        ));
        assert_eq!(files.upload_status(&upload.id).await.unwrap().offset, 3);
        assert!(matches!(
            files.finish_upload(&upload.id, false).await,
            Err(FilesError::Conflict(_))
        ));
        files
            .write_chunk(&upload.id, 3, bytes::Bytes::from_static(b"def"))
            .await
            .unwrap();
        let entry = files.finish_upload(&upload.id, false).await.unwrap();
        assert_eq!(entry.size, 6);
        assert_eq!(std::fs::read(work.join("data.bin")).unwrap(), b"abcdef");
        assert!(matches!(
            files.start_upload(work.clone(), "data.bin", 1, false).await,
            Err(FilesError::Exists(_))
        ));
    }

    #[tokio::test]
    async fn an_upload_takes_the_mode_of_the_file_it_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().to_path_buf();
        std::fs::write(work.join(".env"), "old").unwrap();
        std::fs::set_permissions(work.join(".env"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let files = files();
        for (name, replace) in [(".env", true), ("new.txt", false)] {
            let upload = files
                .start_upload(work.clone(), name, 3, replace)
                .await
                .unwrap();
            let temp = work.join(format!("{UPLOAD_PREFIX}{}", upload.id));
            assert_eq!(
                std::fs::metadata(&temp).unwrap().permissions().mode() & 0o777,
                0o600,
                "only its owner reads an upload as it arrives"
            );
            files
                .write_chunk(&upload.id, 0, bytes::Bytes::from_static(b"new"))
                .await
                .unwrap();
            files.finish_upload(&upload.id, replace).await.unwrap();
        }
        let mode = |name: &str| {
            std::fs::metadata(work.join(name))
                .unwrap()
                .permissions()
                .mode()
        };
        assert_eq!(mode(".env") & 0o777, 0o600);
        assert_eq!(mode("new.txt") & 0o777, new_file_mode());
    }

    #[tokio::test]
    async fn an_upload_too_large_or_misnamed_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().to_path_buf();
        let files = files();
        assert!(matches!(
            files
                .start_upload(work.clone(), "huge", u64::MAX, false)
                .await,
            Err(FilesError::BadPath(_))
        ));
        assert!(
            matches!(
                files
                    .start_upload(work.clone(), ".mekaweb-upload-x", 1, false)
                    .await,
                Err(FilesError::BadPath(_))
            ),
            "an upload's own prefix is not a name"
        );
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_named_pipe_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let pipe = dir.path().join("pipe");
        rustix::fs::mkfifoat(rustix::fs::CWD, &pipe, Mode::from_raw_mode(0o600)).unwrap();
        let files = files();
        let wait = Duration::from_secs(5);
        let text = tokio::time::timeout(wait, files.text(pipe.clone())).await;
        assert!(matches!(text, Ok(Err(FilesError::BadPath(_)))), "{text:?}");
        let raw = tokio::time::timeout(wait, files.open_file(pipe)).await;
        assert!(matches!(raw, Ok(Err(FilesError::BadPath(_)))));
    }

    #[test]
    fn a_tree_is_removed_whatever_its_names_and_without_following_links() {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("a/b")).unwrap();
        std::fs::write(tree.join(OsStr::from_bytes(b"not-utf8-\xff")), "x").unwrap();
        std::fs::write(tree.join("a/b/c"), "x").unwrap();
        std::fs::write(dir.path().join("kept"), "x").unwrap();
        symlink(dir.path(), tree.join("a/up")).unwrap();
        let parent =
            rustix::fs::open(dir.path(), OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        remove_tree(parent.as_fd(), OsStr::new("tree")).unwrap();
        assert!(!tree.exists());
        assert!(
            dir.path().join("kept").exists(),
            "a symlink is removed, not followed"
        );
    }

    #[test]
    fn a_tree_too_deep_is_refused_partway_rather_than_overflowing() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().join("tree");
        for _ in 0..=MAX_DEPTH {
            deep.push("d");
        }
        std::fs::create_dir_all(&deep).unwrap();
        let parent =
            rustix::fs::open(dir.path(), OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        assert!(matches!(
            remove_tree(parent.as_fd(), OsStr::new("tree")),
            Err(FilesError::Refused(_))
        ));
    }

    #[test]
    fn ranges_are_read_as_browsers_ask() {
        let part = |start, length| Range::Part { start, length };
        assert_eq!(parse_range("bytes=0-99", 1000), part(0, 100));
        assert_eq!(parse_range("bytes=900-", 1000), part(900, 100));
        assert_eq!(parse_range("bytes=-100", 1000), part(900, 100));
        assert_eq!(parse_range("bytes=-5000", 1000), part(0, 1000));
        assert_eq!(parse_range("bytes=990-2000", 1000), part(990, 10));
        assert_eq!(parse_range("bytes=1000-", 1000), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 1000), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), Range::Whole);
        assert_eq!(parse_range("items=0-1", 1000), Range::Whole);
        assert_eq!(parse_range("bytes=9-3", 1000), Range::Whole);
        assert_eq!(parse_range("bytes=x-", 1000), Range::Whole);
    }
}
