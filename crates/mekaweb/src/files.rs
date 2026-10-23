//! Files: browsing, reading, downloading, uploading to and tidying any folder mekaweb's user may
//! reach. Signing in is the boundary: whoever is signed in drives meka's agent and a terminal as
//! that user, so Files keeps no folders of its own. The interface opens it at a session's working
//! directory, and watches the folder it shows to list it again as it changes.
//!
//! Paths are absolute, or start with `~`; `.` and `..` are resolved as written, before the file
//! system sees them. A path's last name is acted on itself: a symlink is listed, moved or deleted,
//! never what it points to, while the folders leading to it may be symlinks. Deleting is for good:
//! there is no trash.
//!
//! Files are read only when they are regular files, opened so that a named pipe cannot hold a
//! thread waiting for a writer. Deleting a folder, or zipping one, stays on its disk: a disk
//! mounted inside is left alone, as `rm --one-file-system` would.

mod folder;
pub(crate) mod watch;
pub(crate) mod zip;

use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf, Prefix},
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

pub(crate) use self::folder::{Folder, prepare};
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
pub(crate) const UPLOAD_PREFIX: &str = ".mekaweb-upload-";

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
    #[error(transparent)]
    Io(std::io::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl FilesError {
    /// An I/O error about `what`, told apart where it says something people can act on.
    pub(crate) fn io(error: std::io::Error, what: &str) -> Self {
        use std::io::ErrorKind;
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Self::BadPath(format!("{what} leads through too many symlinks"));
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
            let code = error
                .raw_os_error()
                .and_then(|code| u32::try_from(code).ok());
            if matches!(code, Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)) {
                return Self::Refused(format!("{what} is in use by another program"));
            }
        }
        match error.kind() {
            ErrorKind::NotFound => Self::NotFound(what.to_owned()),
            ErrorKind::AlreadyExists => Self::Exists(what.to_owned()),
            ErrorKind::DirectoryNotEmpty => Self::Conflict(format!("{what} is not empty")),
            ErrorKind::ResourceBusy => {
                Self::Refused(format!("{what} is in use, or a disk is mounted there"))
            }
            ErrorKind::PermissionDenied => {
                Self::Refused(format!("mekaweb is not allowed to do that to {what}"))
            }
            ErrorKind::CrossesDevices => Self::Conflict(format!(
                "{what} is on another disk; download and upload it instead"
            )),
            ErrorKind::NotADirectory => Self::BadPath(format!("a part of {what} is not a folder")),
            ErrorKind::IsADirectory => Self::BadPath(format!("{what} is a folder")),
            ErrorKind::InvalidFilename => {
                Self::BadPath(format!("the name of {what} is too long or not allowed"))
            }
            ErrorKind::InvalidInput => Self::BadPath(format!("that cannot be done to {what}")),
            ErrorKind::StorageFull => Self::Refused("the disk is full".to_owned()),
            ErrorKind::ReadOnlyFilesystem => {
                Self::Refused(format!("{what} is on a read-only disk"))
            }
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
/// as written. On Windows it starts with a drive, `C:\`, or a share, `\\server\share\`, and
/// either slash separates. Nothing is trimmed: a name may begin or end with a space.
pub(crate) fn resolve(path: &str) -> Result<PathBuf, FilesError> {
    if path.contains('\0') {
        return Err(FilesError::BadPath("a path cannot hold a NUL".to_owned()));
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(std::path::is_separator) => {
            crate::config::home()?.join(rest.trim_start_matches(std::path::is_separator))
        }
        _ => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err(FilesError::BadPath(
            "give an absolute path, or one starting with ~/".to_owned(),
        ));
    }
    let mut resolved = PathBuf::new();
    for component in expanded.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(_) | Prefix::UNC(..) => resolved.push(prefix.as_os_str()),
                // The long form names the same drive or share, written plainly.
                Prefix::VerbatimDisk(drive) => {
                    resolved.push(format!("{}:", char::from(drive)));
                }
                Prefix::VerbatimUNC(server, share) => {
                    let mut plain = OsString::from(r"\\");
                    plain.push(server);
                    plain.push(r"\");
                    plain.push(share);
                    resolved.push(plain);
                }
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
                    return Err(FilesError::BadPath(
                        "a device's path is not a folder's".to_owned(),
                    ));
                }
            },
            Component::RootDir => resolved.push(Component::RootDir),
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
            Component::CurDir => {}
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
fn open_folder(path: &Path) -> Result<Folder, FilesError> {
    Folder::open(path).map_err(|error| FilesError::io(error, &shown(path)))
}

/// Names Windows keeps for devices, with or without an extension.
#[cfg(windows)]
const DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Checks a name for a new file or folder, taken as it is written.
pub(crate) fn check_name(name: &OsStr) -> Result<&OsStr, FilesError> {
    let Some(text) = name.to_str() else {
        return Err(FilesError::BadPath("a name must be valid text".to_owned()));
    };
    if text.is_empty() || text == "." || text == ".." {
        return Err(FilesError::BadPath(
            "a name cannot be empty, . or ..".to_owned(),
        ));
    }
    if text.contains(['/', '\0']) {
        return Err(FilesError::BadPath(
            "a name cannot hold a / or a NUL".to_owned(),
        ));
    }
    #[cfg(unix)]
    if text.len() > 255 {
        return Err(FilesError::BadPath(
            "a name is at most 255 bytes".to_owned(),
        ));
    }
    #[cfg(windows)]
    {
        if text.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || text.chars().any(char::is_control)
        {
            return Err(FilesError::BadPath(
                r#"a name cannot hold \ : * ? " < > | or a control character"#.to_owned(),
            ));
        }
        if text.ends_with(['.', ' ']) {
            return Err(FilesError::BadPath(
                "a name cannot end with a dot or a space".to_owned(),
            ));
        }
        let stem = text.split('.').next().unwrap_or_default().trim_end();
        if DEVICE_NAMES
            .iter()
            .any(|device| device.eq_ignore_ascii_case(stem))
        {
            return Err(FilesError::BadPath(format!(
                "{stem} names a device on Windows"
            )));
        }
        if text.encode_utf16().count() > 255 {
            return Err(FilesError::BadPath(
                "a name is at most 255 characters".to_owned(),
            ));
        }
    }
    if text.starts_with(UPLOAD_PREFIX) {
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

/// An entry in a folder.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) kind: Kind,
    /// Its size in bytes; a folder's is what the file system says of it.
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
    /// Its permissions, as `ls` writes them: `rwxr-xr-x`. Windows has none.
    pub(crate) permissions: Option<String>,
    /// Where a symlink points, as written.
    pub(crate) target: Option<String>,
    /// What a symlink leads to, if anything.
    pub(crate) target_kind: Option<Kind>,
    /// Whether its name starts with a dot, or the system marks it hidden.
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
    /// Entries chosen to download as one zip, by the id their download names them by.
    selections: Mutex<HashMap<String, Selection>>,
    /// The folders watched for changes.
    watcher: watch::Watcher,
}

/// Entries chosen in a folder, to download as one zip.
#[derive(Debug, Clone)]
pub(crate) struct Selection {
    pub(crate) folder: PathBuf,
    pub(crate) names: Vec<String>,
    made: Instant,
}

/// How long a selection lasts for its download to start, or start again.
const SELECTION_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// The most selections kept; the oldest goes for a new one past that.
const MAX_SELECTIONS: usize = 64;

impl Files {
    /// Files, with uploads kept in `store`.
    pub(crate) fn new(store: Store) -> Self {
        folder::prepare();
        Self {
            store,
            selections: Mutex::new(HashMap::new()),
            watcher: watch::Watcher::new(),
        }
    }

    /// Keeps `names` in the folder `folder` for a zip of them; the id to download it by.
    pub(crate) fn select(&self, folder: PathBuf, names: Vec<String>) -> Result<String, FilesError> {
        for name in &names {
            check_name(OsStr::new(name))?;
        }
        let id = Uuid::new_v4().to_string();
        let mut selections = self
            .selections
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        selections.retain(|_, selection| selection.made.elapsed() < SELECTION_LIFETIME);
        if selections.len() >= MAX_SELECTIONS
            && let Some(oldest) = selections
                .iter()
                .min_by_key(|(_, selection)| selection.made)
                .map(|(id, _)| id.clone())
        {
            selections.remove(&oldest);
        }
        selections.insert(id.clone(), Selection {
            folder,
            names,
            made: Instant::now(),
        });
        drop(selections);
        Ok(id)
    }

    /// The selection `id` names, while it lasts.
    pub(crate) fn selection(&self, id: &str) -> Result<Selection, FilesError> {
        self.selections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .filter(|selection| selection.made.elapsed() < SELECTION_LIFETIME)
            .cloned()
            .ok_or_else(|| {
                FilesError::NotFound("that selection, which lasts ten minutes,".to_owned())
            })
    }

    /// Lists the folder `path`.
    pub(crate) async fn list(&self, path: PathBuf) -> Result<Listing, FilesError> {
        blocking(move || {
            let folder = open_folder(&path)?;
            let names = folder
                .names()
                .map_err(|error| FilesError::io(error, &shown(&path)))?;
            let mut entries = Vec::new();
            for name in names {
                // A name that is not valid text cannot be named back in a request.
                let Some(name) = name.to_str() else {
                    continue;
                };
                if name.starts_with(UPLOAD_PREFIX) {
                    continue;
                }
                match entry(&folder, name) {
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

    /// Opens a folder to download as a zip, which must be one mekaweb may read: the download
    /// starts once it is open, past when it could say so.
    pub(crate) async fn open_folder(&self, path: PathBuf) -> Result<Folder, FilesError> {
        blocking(move || {
            Folder::open_readable(&path).map_err(|error| FilesError::io(error, &shown(&path)))
        })
        .await
    }

    /// Follows the folder `path` for changes.
    pub(crate) async fn watch(&self, path: PathBuf) -> Result<watch::Watching, FilesError> {
        let watcher = self.watcher.clone();
        blocking(move || watcher.follow(&path)).await
    }

    /// Makes the folder `path`, and with `parents` any folders above it that are missing.
    pub(crate) async fn make_folder(
        &self,
        path: PathBuf,
        parents: bool,
    ) -> Result<Entry, FilesError> {
        blocking(move || {
            let (parent, name) = split(&path)?;
            let name = check_name(name)?;
            if parents {
                std::fs::create_dir_all(parent)
                    .map_err(|error| FilesError::io(error, &shown(parent)))?;
            }
            let folder = open_folder(parent)?;
            folder.make_folder(name).or_else(|error| {
                // Asked for with its parents, a folder that is there already is made, as with
                // `mkdir -p`; anything else there is not a folder made.
                let there = || {
                    folder
                        .stat_followed(name)
                        .is_ok_and(|stat| stat.kind == Kind::Folder)
                };
                if parents && error.kind() == std::io::ErrorKind::AlreadyExists && there() {
                    Ok(())
                } else {
                    Err(FilesError::io(error, &shown(&path)))
                }
            })?;
            entry(&folder, &name.to_string_lossy())
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
            let source = open_folder(from_parent)?;
            let target = open_folder(to_parent)?;
            source
                .rename(from_name, &target, to_name, false)
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::AlreadyExists => FilesError::Exists(shown(&to)),
                    _ => FilesError::io(error, &shown(&from)),
                })
        })
        .await
    }

    /// Deletes `path` for good, and everything in it.
    pub(crate) async fn delete(&self, path: PathBuf) -> Result<(), FilesError> {
        blocking(move || {
            let (parent, name) = split(&path)?;
            let folder = open_folder(parent)?;
            if folder
                .is_mount(name)
                .map_err(|error| FilesError::io(error, &shown(&path)))?
            {
                return Err(FilesError::Refused(format!(
                    "{} is another disk, mounted there; unmount it rather than delete it",
                    shown(&path)
                )));
            }
            remove_tree(&folder, name)
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
            let folder = open_folder(&folder_path)?;
            if !replace && folder.stat(OsStr::new(&checked)).is_ok() {
                return Err(FilesError::Exists(checked));
            }
            // Only its owner reads it while it arrives; it takes its proper mode when finished.
            folder
                .create_new(OsStr::new(&created))
                .map_err(|error| FilesError::io(error, &created))?;
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
            if let Err(error) = folder.remove_file(OsStr::new(&temp)) {
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

    /// Opens an upload's unfinished file, to read or with `write` to write, which must be a
    /// regular file of its own.
    fn open_upload(row: &UploadRow, write: bool) -> Result<File, FilesError> {
        let folder = open_folder(Path::new(&row.dir))?;
        let file = folder
            .open_file(OsStr::new(&row.temp), write)
            .map_err(|error| FilesError::io(error, "the upload"))?;
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
            let file = Self::open_upload(&row, false)?;
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
            let file = Self::open_upload(&upload, true)?;
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
            folder::write_all_at(&file, &bytes, offset)
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
            let folder = open_folder(Path::new(&finished.dir))?;
            let temp = OsStr::new(&finished.temp);
            let name = OsStr::new(&finished.name);
            // The upload as opened, never through a symlink put in its place, is checked and
            // given its mode through that one handle.
            let upload = folder
                .open_file(temp, false)
                .map_err(|error| FilesError::io(error, "the upload"))?;
            let metadata = upload
                .metadata()
                .map_err(|error| FilesError::io(error, "the upload"))?;
            if !metadata.is_file() {
                return Err(FilesError::Conflict("the upload is not a file".to_owned()));
            }
            if metadata.len() != finished.size {
                return Err(FilesError::Conflict(format!(
                    "the upload has {} of its {} bytes",
                    metadata.len(),
                    finished.size
                )));
            }
            // A file replaced keeps its mode; a new one takes the one new files get.
            folder
                .give_mode(&upload, name, replace)
                .map_err(|error| FilesError::io(error, "the upload"))?;
            // Closed first: Windows renames no file held open.
            drop(upload);
            folder
                .rename(temp, &folder, name, replace)
                .map_err(|error| FilesError::io(error, &finished.name))?;
            entry(&folder, &finished.name)
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
            let folder = open_folder(&dir)?;
            match folder.remove_file(OsStr::new(&temp)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(FilesError::io(error, "the upload")),
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

/// The entry `name` in `folder`, a symlink as itself.
fn entry(folder: &Folder, name: &str) -> Result<Entry, FilesError> {
    let stat = folder
        .stat(OsStr::new(name))
        .map_err(|error| FilesError::io(error, name))?;
    let (target, target_kind) = if stat.kind == Kind::Symlink {
        let target = folder
            .read_link(OsStr::new(name))
            .ok()
            .map(|target| target.to_string_lossy().into_owned());
        let followed = folder
            .stat_followed(OsStr::new(name))
            .ok()
            .map(|stat| stat.kind);
        (target, followed)
    } else {
        (None, None)
    };
    Ok(Entry {
        name: name.to_owned(),
        kind: stat.kind,
        size: stat.size,
        modified: stat.modified,
        permissions: stat.mode.map(permissions),
        target,
        target_kind,
        hidden: name.starts_with('.') || stat.hidden,
    })
}

/// When `metadata` says its file was last changed.
fn modified(metadata: &Metadata) -> Option<DateTime<Utc>> {
    metadata.modified().ok().map(DateTime::<Utc>::from)
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

/// Opens `path`, its symlinks followed, to read, if it is a regular file: neither a named pipe nor
/// a device, which can act on being opened, is.
fn open_regular(path: &Path) -> Result<(File, Metadata), FilesError> {
    let file = folder::open_regular(path)
        .map_err(|error| FilesError::io(error, &shown(path)))?
        .ok_or_else(|| FilesError::BadPath(format!("{} is not a file", shown(path))))?;
    let metadata = file
        .metadata()
        .map_err(|error| FilesError::io(error, &shown(path)))?;
    Ok((file, metadata))
}

/// A folder being removed: what it is called in its parent, and the names in it left to remove.
struct Removing {
    folder: Folder,
    name: OsString,
    left: Vec<OsString>,
}

impl Removing {
    fn open(parent: &Folder, name: &OsStr) -> Result<Self, FilesError> {
        let shown = name.to_string_lossy();
        let folder = parent
            .open_folder(name)
            .map_err(|error| FilesError::io(error, &shown))?;
        // A folder that cannot be read to its end is not removed: what was missed would stay.
        let left = folder
            .names()
            .map_err(|error| FilesError::io(error, &shown))?;
        Ok(Self {
            folder,
            name: name.to_owned(),
            left,
        })
    }
}

/// Removes `name` in `parent`, and everything in it, without following a symlink, and without
/// going into another disk mounted inside: what is on one is left, and the folders holding it.
pub(crate) fn remove_tree(parent: &Folder, name: &OsStr) -> Result<(), FilesError> {
    let shown = |name: &OsStr| name.to_string_lossy().into_owned();
    let top = parent
        .stat(name)
        .map_err(|error| FilesError::io(error, &shown(name)))?;
    if top.kind != Kind::Folder {
        return parent
            .remove_file(name)
            .map_err(|error| FilesError::io(error, &shown(name)));
    }
    let mut mounts_left = false;
    let mut stack = vec![Removing::open(parent, name)?];
    loop {
        let depth = stack.len();
        let Some(current) = stack.last_mut() else {
            break;
        };
        let Some(item) = current.left.pop() else {
            let Some(done) = stack.pop() else {
                break;
            };
            let holder = stack.last().map_or(parent, |above| &above.folder);
            match holder.remove_folder(&done.name) {
                Ok(()) => {}
                // What holds a mounted disk stays.
                Err(error)
                    if mounts_left && error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                Err(error) => return Err(FilesError::io(error, &shown(&done.name))),
            }
            continue;
        };
        let stat = match current.folder.stat(&item) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(FilesError::io(error, &shown(&item))),
        };
        if stat.kind != Kind::Folder {
            current
                .folder
                .remove_file(&item)
                .map_err(|error| FilesError::io(error, &shown(&item)))?;
            continue;
        }
        if current.folder.leaves_disk(&item, &stat, top.disk) {
            mounts_left = true;
            continue;
        }
        if depth >= MAX_DEPTH {
            return Err(FilesError::Refused(format!(
                "{} holds folders more than {MAX_DEPTH} deep; delete it from a terminal",
                shown(name)
            )));
        }
        let next = Removing::open(&current.folder, &item)?;
        stack.push(next);
    }
    if mounts_left {
        return Err(FilesError::Refused(format!(
            "another disk is mounted inside {}; it and the folders holding it were left",
            shown(name)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> Files {
        Files::new(Store::in_memory().unwrap())
    }

    /// Makes a named pipe at `path`, with `mkfifo`: rustix has no `mkfifoat` on macOS.
    #[cfg(unix)]
    pub(crate) fn make_pipe(path: &Path) {
        let made = std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .unwrap();
        assert!(made.success());
    }

    #[cfg(unix)]
    #[test]
    fn paths_are_absolute_with_their_dots_resolved() {
        assert_eq!(resolve("/a/b/").unwrap(), Path::new("/a/b"));
        assert_eq!(resolve("/a/./b/../c").unwrap(), Path::new("/a/c"));
        assert_eq!(resolve("/../..").unwrap(), Path::new("/"));
        assert_eq!(
            resolve("/a/report ").unwrap(),
            Path::new("/a/report "),
            "a name's spaces are its own"
        );
        for bad in ["relative", "~user/x", "", " /a", "/a\0b", "~\\x"] {
            assert!(resolve(bad).is_err(), "{bad:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn paths_start_at_a_drive_or_share_with_their_dots_resolved() {
        assert_eq!(resolve(r"C:\a\b\").unwrap(), Path::new(r"C:\a\b"));
        assert_eq!(resolve("C:/a/./b/../c").unwrap(), Path::new(r"C:\a\c"));
        assert_eq!(resolve(r"C:\..\..").unwrap(), Path::new(r"C:\"));
        assert_eq!(resolve(r"\\?\D:\x").unwrap(), Path::new(r"D:\x"));
        assert_eq!(
            resolve(r"\\server\share\a\..\..").unwrap(),
            Path::new(r"\\server\share\")
        );
        assert_eq!(
            resolve(r"\\?\UNC\server\share\a").unwrap(),
            Path::new(r"\\server\share\a")
        );
        for bad in ["relative", r"\a", "C:a", r"\\.\COM1", "", "C:\\a\0b"] {
            assert!(resolve(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn home_is_where_a_tilde_starts() {
        let home = crate::config::home().unwrap();
        assert_eq!(resolve("~").unwrap(), home);
        assert_eq!(resolve("~/x").unwrap(), home.join("x"));
    }

    #[test]
    fn names_are_checked_as_written() {
        for good in ["a.txt", " spaced", ".env", "naïve"] {
            assert!(check_name(OsStr::new(good)).is_ok(), "{good:?}");
        }
        for bad in ["", ".", "..", "a/b", "a\0b", ".mekaweb-upload-x"] {
            assert!(check_name(OsStr::new(bad)).is_err(), "{bad:?}");
        }
        #[cfg(windows)]
        for bad in [
            r"a\b",
            "a:b",
            "a?",
            "trailing.",
            "trailing ",
            "con",
            "NUL.txt",
            "lpt1 ",
        ] {
            assert!(check_name(OsStr::new(bad)).is_err(), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_is_listed_as_itself_and_acted_on_as_itself() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(dir.path().join("secret"), "keys").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret"), work.join("link")).unwrap();
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
    async fn a_listing_says_what_each_entry_is() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("inner")).unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        std::fs::write(dir.path().join(".hidden"), "").unwrap();
        let listing = files().list(dir.path().to_path_buf()).await.unwrap();
        let names: Vec<(&str, Kind, bool)> = listing
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind, entry.hidden))
            .collect();
        assert_eq!(names, [
            (".hidden", Kind::File, true),
            ("a.txt", Kind::File, false),
            ("inner", Kind::Folder, false)
        ]);
        let file = &listing.entries[1];
        assert_eq!(file.size, 5);
        assert!(file.modified.is_some());
        assert_eq!(file.permissions.is_some(), cfg!(unix));
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
        std::fs::create_dir_all(path.join("a").join("b")).unwrap();
        std::fs::write(path.join("x"), "x").unwrap();
        std::fs::write(path.join("y"), "y").unwrap();
        let files = files();
        assert!(matches!(
            files.move_entry(path.join("x"), path.join("y")).await,
            Err(FilesError::Exists(_))
        ));
        assert!(matches!(
            files
                .move_entry(path.join("a"), path.join("a").join("b").join("a"))
                .await,
            Err(FilesError::BadPath(_))
        ));
        files
            .move_entry(path.join("x"), path.join("a").join("b").join("z"))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(path.join("a").join("b").join("z")).unwrap(),
            "x"
        );
        files
            .move_entry(path.join("a"), path.join("c"))
            .await
            .unwrap();
        assert!(
            path.join("c").join("b").join("z").exists(),
            "a folder moves"
        );
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
        let deep = dir.path().join("p").join("q");
        assert!(files.make_folder(deep.clone(), false).await.is_err());
        files.make_folder(deep.clone(), true).await.unwrap();
        files.make_folder(deep.clone(), true).await.unwrap();
        assert!(deep.is_dir());
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
        let again = files
            .start_upload(work.clone(), "data.bin", 3, true)
            .await
            .unwrap();
        files
            .write_chunk(&again.id, 0, bytes::Bytes::from_static(b"new"))
            .await
            .unwrap();
        files.finish_upload(&again.id, true).await.unwrap();
        assert_eq!(
            std::fs::read(work.join("data.bin")).unwrap(),
            b"new",
            "an upload replaces a file when asked to"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_upload_takes_the_mode_of_the_file_it_replaces() {
        use std::os::unix::fs::PermissionsExt;
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
        assert_eq!(mode("new.txt") & 0o777, folder::new_file_mode());
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

    #[cfg(unix)]
    #[tokio::test]
    async fn a_named_pipe_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let pipe = dir.path().join("pipe");
        make_pipe(&pipe);
        let files = files();
        let wait = Duration::from_secs(5);
        let text = tokio::time::timeout(wait, files.text(pipe.clone())).await;
        assert!(matches!(text, Ok(Err(FilesError::BadPath(_)))), "{text:?}");
        let raw = tokio::time::timeout(wait, files.open_file(pipe)).await;
        assert!(matches!(raw, Ok(Err(FilesError::BadPath(_)))));
    }

    #[tokio::test]
    async fn a_tree_is_deleted_with_its_read_only_files() {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("a").join("b")).unwrap();
        std::fs::write(tree.join("a").join("b").join("c"), "x").unwrap();
        let locked = tree.join("a").join("locked");
        std::fs::write(&locked, "x").unwrap();
        let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&locked, permissions).unwrap();
        std::fs::write(dir.path().join("kept"), "x").unwrap();
        files().delete(tree.clone()).await.unwrap();
        assert!(!tree.exists());
        assert!(dir.path().join("kept").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_tree_is_removed_whatever_its_names_and_without_following_links() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("a/b")).unwrap();
        std::fs::write(tree.join(OsStr::from_bytes(b"not-utf8-\xff")), "x").unwrap();
        std::fs::write(tree.join("a/b/c"), "x").unwrap();
        std::fs::write(dir.path().join("kept"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path(), tree.join("a/up")).unwrap();
        let parent = Folder::open(dir.path()).unwrap();
        remove_tree(&parent, OsStr::new("tree")).unwrap();
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
        let parent = Folder::open(dir.path()).unwrap();
        assert!(matches!(
            remove_tree(&parent, OsStr::new("tree")),
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
