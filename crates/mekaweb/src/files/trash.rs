//! The trash, as the freedesktop.org Trash specification lays it out, so a desktop's file manager
//! and `gio trash` see what Files threw away and Files sees theirs. An item on the home folder's
//! disk goes to `$XDG_DATA_HOME/Trash`; one on another disk goes to that disk's own trash at its
//! mount point, `.Trash/$uid` where an administrator made `.Trash` (sticky, not a symlink), or else
//! `.Trash-$uid`. Either way it is renamed, never copied, so throwing something away is instant
//! and nothing leaves its disk. The disk is the one of the folder an item is in, found from that
//! folder as opened, so neither a symlink nor a path written through one leads anywhere else.

use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    os::{
        fd::{AsFd, BorrowedFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rustix::fs::{Mode, OFlags, RenameFlags};
use serde::Serialize;
use utoipa::ToSchema;

use super::{FilesError, Kind, remove_tree, write_new};

/// What an item's info file is called, after the item's name in the trash.
const INFO_SUFFIX: &str = ".trashinfo";

/// The most names tried before giving up on finding a free one.
const MAX_TRIES: u32 = 10_000;

/// Something in a trash.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct Trashed {
    /// What names it to restore or delete it.
    pub(crate) id: String,
    /// Its name where it was.
    pub(crate) name: String,
    /// Where it was, absolute.
    pub(crate) path: String,
    /// When it was thrown away, as the info file says, in local time.
    pub(crate) deleted_at: String,
    pub(crate) kind: Kind,
    /// Its size; a folder's is what the file system says of it.
    pub(crate) size: u64,
}

/// An item in a trash folder.
#[derive(Debug, Clone)]
pub(crate) struct Item {
    /// The trash folder: the one holding `files` and `info`.
    trash: PathBuf,
    /// Its name in `files`.
    name: String,
    /// Where it was.
    pub(crate) original: PathBuf,
    deleted_at: String,
}

/// The user's id.
fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}

/// The home folder's trash: `$XDG_DATA_HOME/Trash`, or `~/.local/share/Trash`.
pub(crate) fn home_trash() -> anyhow::Result<PathBuf> {
    let data = match std::env::var_os("XDG_DATA_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => crate::config::home()?.join(".local/share"),
    };
    Ok(data.join("Trash"))
}

/// The device a path is on, following symlinks; or of the nearest folder above it that exists.
fn device(path: &Path) -> Option<u64> {
    path.ancestors()
        .find_map(|ancestor| std::fs::metadata(ancestor).ok())
        .map(|metadata| metadata.dev())
}

/// The mount point of the disk `dev`, which the folder `path` is on, symlinks resolved: the
/// highest folder above it on that disk.
fn mount_point(path: &Path, dev: u64) -> PathBuf {
    let mut top = path.to_path_buf();
    for ancestor in path.ancestors().skip(1) {
        match std::fs::metadata(ancestor) {
            Ok(metadata) if metadata.dev() == dev => top = ancestor.to_path_buf(),
            _ => break,
        }
    }
    top
}

/// Where the folder `fd` is, its symlinks resolved, as the kernel knows it.
fn real_path(fd: BorrowedFd<'_>) -> Result<PathBuf, FilesError> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))
        .map_err(|error| FilesError::io(error, "the folder"))
}

/// The trash folder for something on the disk `dev`, in the folder `folder` there (symlinks
/// resolved); made if `make`.
fn trash_for(home: &Path, dev: u64, folder: &Path, make: bool) -> Result<PathBuf, FilesError> {
    if device(home) == Some(dev) {
        if make {
            make_private(home)?;
        }
        return Ok(home.to_path_buf());
    }
    let top = mount_point(folder, dev);
    let shared = top.join(".Trash");
    let shared_ok = std::fs::symlink_metadata(&shared)
        .is_ok_and(|metadata| metadata.is_dir() && metadata.permissions().mode() & 0o1000 != 0);
    let trash = if shared_ok {
        shared.join(uid().to_string())
    } else {
        top.join(format!(".Trash-{}", uid()))
    };
    if make {
        make_private(&trash)?;
    }
    Ok(trash)
}

/// Makes a folder only its owner can enter, if it is not there; refuses a symlink in its place.
fn make_private(path: &Path) -> Result<(), FilesError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && metadata.uid() == uid() => Ok(()),
        Ok(_) => Err(FilesError::Refused(format!(
            "{} is not a trash folder of yours",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|error| FilesError::io(error, &path.display().to_string())),
        Err(error) => Err(FilesError::io(error, &path.display().to_string())),
    }
}

/// Opens a trash's `files` or `info` folder, making it if `make`.
fn open_part(trash: &Path, part: &str, make: bool) -> Result<OwnedFd, FilesError> {
    let path = trash.join(part);
    if make {
        make_private(&path)?;
    }
    rustix::fs::open(
        &path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| FilesError::io(error.into(), &path.display().to_string()))
}

/// Moves `name` in the folder `parent`, which is `absolute`, to the trash.
pub(crate) fn trash(
    home: &Path,
    parent: BorrowedFd<'_>,
    name: &OsStr,
    absolute: &Path,
) -> Result<(), FilesError> {
    let dev = rustix::fs::fstat(parent)
        .map_err(|error| FilesError::io(error.into(), "the folder"))?
        .st_dev;
    // A disk whose trash cannot be made or opened, as where mekaweb's user may not write at its
    // top, has none: what is on it can be deleted for good instead.
    let (files, info) = trash_for(home, dev, &real_path(parent)?, true)
        .and_then(|trash| {
            Ok((
                open_part(&trash, "files", true)?,
                open_part(&trash, "info", true)?,
            ))
        })
        .map_err(|error| FilesError::NoTrash(format!("its disk has no trash to use: {error}")))?;
    let content = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        encode(absolute),
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S")
    );
    // Room for the info file's suffix and a number after the name; the info file keeps the name
    // it had, whatever its name in the trash.
    let lossy = name.to_string_lossy();
    let base = shortened(&lossy, NAME_MAX - INFO_SUFFIX.len() - 6);
    for attempt in 1..=MAX_TRIES {
        let candidate = if attempt == 1 {
            base.to_owned()
        } else {
            format!("{base}.{attempt}")
        };
        let info_name = format!("{candidate}{INFO_SUFFIX}");
        // The info file is made first, which claims the name: two items thrown away at once never
        // take the same one.
        match write_new(info.as_fd(), &info_name, content.as_bytes()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(FilesError::io(error, "the trash")),
        }
        let moved = rustix::fs::renameat_with(
            parent,
            name,
            &files,
            candidate.as_str(),
            RenameFlags::NOREPLACE,
        );
        let Err(error) = moved else {
            return Ok(());
        };
        if let Err(cleanup) =
            rustix::fs::unlinkat(&info, info_name.as_str(), rustix::fs::AtFlags::empty())
        {
            tracing::warn!("could not remove an unused trash info file: {cleanup}");
        }
        match error.raw_os_error() {
            // Something in the trash has that name with no info file of its own: try the next.
            libc::EEXIST | libc::ENOTEMPTY => {}
            libc::EXDEV => {
                return Err(FilesError::NoTrash(
                    "it cannot be moved to a trash on its disk".to_owned(),
                ));
            }
            _ => {
                return Err(FilesError::io(
                    error.into(),
                    &absolute.display().to_string(),
                ));
            }
        }
    }
    Err(FilesError::Conflict(
        "the trash has no free name".to_owned(),
    ))
}

/// The longest name a file may have, in bytes.
const NAME_MAX: usize = 255;

/// `name`, cut to at most `max` bytes at a character's edge.
fn shortened(name: &str, max: usize) -> &str {
    if name.len() <= max {
        return name;
    }
    let mut end = max;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name.get(..end).unwrap_or(name)
}

/// The trash folders there are: the home folder's, and each disk's own, where it has one of
/// the user's.
fn trashes(home: &Path) -> Vec<PathBuf> {
    let mut trashes: Vec<PathBuf> = vec![home.to_path_buf()];
    let owner = uid();
    let mine = |path: &Path| {
        std::fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == owner)
    };
    for top in mount_points() {
        let shared = top.join(".Trash");
        let shared_ok = std::fs::symlink_metadata(&shared)
            .is_ok_and(|metadata| metadata.is_dir() && metadata.permissions().mode() & 0o1000 != 0);
        let candidates = [
            shared_ok.then(|| shared.join(owner.to_string())),
            Some(top.join(format!(".Trash-{owner}"))),
        ];
        for trash in candidates.into_iter().flatten() {
            if mine(&trash) && !trashes.contains(&trash) {
                trashes.push(trash);
            }
        }
    }
    trashes
}

/// File systems a trash is not looked for on: the kernel's own, those mounted on demand, which
/// looking would mount, and those over a network, which can leave the look waiting.
const NO_TRASH_SYSTEMS: &[&str] = &[
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "mqueue",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "bpf",
    "configfs",
    "fusectl",
    "hugetlbfs",
    "binfmt_misc",
    "efivarfs",
    "selinuxfs",
    "nsfs",
    "rpc_pipefs",
    "autofs",
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "smbfs",
    "9p",
    "afs",
    "ceph",
    "glusterfs",
    "davfs",
    "fuse.sshfs",
    "fuse.rclone",
    "fuse.s3fs",
    "fuse.gvfsd-fuse",
    "fuse.portal",
];

/// Where the file systems that can hold a trash are mounted, as `/proc/self/mountinfo` says.
fn mount_points() -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string("/proc/self/mountinfo") else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| {
            // The file system's type is the first field after the ` - ` separator.
            let system = line
                .split_once(" - ")
                .and_then(|(_, rest)| rest.split(' ').next());
            !system.is_some_and(|system| NO_TRASH_SYSTEMS.contains(&system))
        })
        .filter_map(|line| line.split(' ').nth(4))
        .map(|field| PathBuf::from(OsStr::from_bytes(&unescape(field))))
        .collect()
}

/// A field of `/proc/self/mountinfo`, its `\ooo` escapes for spaces and the like undone.
fn unescape(field: &str) -> Vec<u8> {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(byte) = bytes.get(index) {
        let octal = bytes
            .get(index + 1..index + 4)
            .and_then(|digits| std::str::from_utf8(digits).ok())
            .and_then(|digits| u8::from_str_radix(digits, 8).ok());
        match (byte, octal) {
            (b'\\', Some(value)) => {
                out.push(value);
                index += 4;
            }
            _ => {
                out.push(*byte);
                index += 1;
            }
        }
    }
    out
}

/// Reads the info file `name` in the folder `info`, if it is a regular file of sensible size.
fn read_info(info: BorrowedFd<'_>, name: &OsStr) -> Option<String> {
    let fd = rustix::fs::openat(
        info,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let file = File::from(fd);
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(64 * 1024).read_to_string(&mut text).ok()?;
    Some(text)
}

/// The items in `trash`.
fn items(trash: &Path) -> Vec<Item> {
    let Ok(info) = open_part(trash, "info", false) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(trash.join("info")) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let name = file_name.to_str()?.strip_suffix(INFO_SUFFIX)?.to_owned();
            let text = read_info(info.as_fd(), &file_name)?;
            let (path, deleted_at) = parse_info(&text)?;
            let original = if path.is_absolute() {
                path
            } else {
                // A relative path is from the disk's mount point, the trash folder's parent (or
                // grandparent, under a shared `.Trash`).
                let top = if trash.parent()?.file_name() == Some(OsStr::new(".Trash")) {
                    trash.parent()?.parent()?
                } else {
                    trash.parent()?
                };
                top.join(path)
            };
            Some(Item {
                trash: trash.to_path_buf(),
                name,
                original,
                deleted_at,
            })
        })
        .collect()
}

/// What the trashes hold, most recently thrown away first.
pub(crate) fn list(home: &Path) -> Vec<Trashed> {
    list_in(&trashes(home))
}

/// What the trash folders `trashes` hold, most recently thrown away first.
fn list_in(trashes: &[PathBuf]) -> Vec<Trashed> {
    let mut trashed: Vec<Trashed> = Vec::new();
    for trash in trashes {
        for item in items(trash) {
            let Ok(metadata) = std::fs::symlink_metadata(item.trash.join("files").join(&item.name))
            else {
                continue;
            };
            trashed.push(Trashed {
                id: id(&item),
                name: item
                    .original
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: item.original.display().to_string(),
                deleted_at: item.deleted_at.clone(),
                kind: Kind::of(&metadata),
                size: metadata.len(),
            });
        }
    }
    trashed.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    trashed
}

/// What names `item` in requests.
fn id(item: &Item) -> String {
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(item.trash.as_os_str().as_bytes()),
        URL_SAFE_NO_PAD.encode(item.name.as_bytes())
    )
}

/// The trashed item `id` names, from one of the trashes there are.
pub(crate) fn find(home: &Path, id: &str) -> Result<Item, FilesError> {
    find_in(&trashes(home), id)
}

/// The trashed item `id` names, from one of the trash folders `trashes`.
fn find_in(trashes: &[PathBuf], id: &str) -> Result<Item, FilesError> {
    let missing = || FilesError::NotFound("that item in the trash".to_owned());
    let (trash, name) = id.split_once('.').ok_or_else(missing)?;
    let trash = PathBuf::from(OsStr::from_bytes(
        &URL_SAFE_NO_PAD.decode(trash).map_err(|_| missing())?,
    ));
    let name = String::from_utf8(URL_SAFE_NO_PAD.decode(name).map_err(|_| missing())?)
        .map_err(|_| missing())?;
    if name.contains('/') || name == "." || name == ".." || !trashes.contains(&trash) {
        return Err(missing());
    }
    items(&trash)
        .into_iter()
        .find(|item| item.name == name)
        .ok_or_else(missing)
}

/// Puts `item` back as `name` in the folder `parent`, never over something there now.
pub(crate) fn restore(item: &Item, parent: BorrowedFd<'_>, name: &OsStr) -> Result<(), FilesError> {
    let files = open_part(&item.trash, "files", false)?;
    rustix::fs::renameat_with(
        &files,
        item.name.as_str(),
        parent,
        name,
        RenameFlags::NOREPLACE,
    )
    .map_err(|error| match error.raw_os_error() {
        libc::EXDEV => FilesError::Conflict(
            "the folder it was in is on another disk now; move it back from a terminal".to_owned(),
        ),
        libc::EEXIST => FilesError::Exists(item.original.display().to_string()),
        _ => FilesError::io(error.into(), &item.original.display().to_string()),
    })?;
    remove_info(item)
}

/// Deletes `item` for good.
pub(crate) fn purge(item: &Item) -> Result<(), FilesError> {
    let files = open_part(&item.trash, "files", false)?;
    remove_tree(files.as_fd(), OsStr::new(&item.name))?;
    remove_info(item)
}

fn remove_info(item: &Item) -> Result<(), FilesError> {
    let info = open_part(&item.trash, "info", false)?;
    rustix::fs::unlinkat(
        &info,
        format!("{}{INFO_SUFFIX}", item.name).as_str(),
        rustix::fs::AtFlags::empty(),
    )
    .map_err(|error| FilesError::io(error.into(), "the trash's note of it"))
}

/// The `Path` and `DeletionDate` of an info file.
fn parse_info(text: &str) -> Option<(PathBuf, String)> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "[Trash Info]" {
        return None;
    }
    let mut path = None;
    let mut date = String::new();
    for line in lines {
        if let Some(value) = line.strip_prefix("Path=") {
            path = Some(PathBuf::from(OsStr::from_bytes(&decode(value.trim())?)));
        } else if let Some(value) = line.strip_prefix("DeletionDate=") {
            date = value.trim().to_owned();
        }
    }
    path.map(|path| (path, date))
}

/// `path` percent-encoded as the specification asks, keeping `/`.
fn encode(path: &Path) -> String {
    let mut out = String::new();
    for byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(*byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Percent-decodes `text`.
fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(byte) = bytes.get(index) {
        if *byte == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(*byte);
            index += 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_encode_and_decode() {
        let path = Path::new("/home/me/a b/naïve%.txt");
        let encoded = encode(path);
        assert_eq!(encoded, "/home/me/a%20b/na%C3%AFve%25.txt");
        assert_eq!(decode(&encoded).unwrap(), path.as_os_str().as_bytes());
        assert_eq!(decode("%zz"), None);
    }

    #[test]
    fn mount_points_are_read_with_their_escapes() {
        assert_eq!(unescape("/mnt/my\\040disk"), b"/mnt/my disk");
        assert_eq!(unescape("/plain"), b"/plain");
        assert_eq!(unescape("/odd\\"), b"/odd\\");
        assert!(mount_points().contains(&PathBuf::from("/")));
    }

    #[test]
    fn an_info_file_reads() {
        let (path, date) =
            parse_info("[Trash Info]\nPath=/tmp/a%20b\nDeletionDate=2026-10-21T10:00:00\n")
                .unwrap();
        assert_eq!(path, Path::new("/tmp/a b"));
        assert_eq!(date, "2026-10-21T10:00:00");
        assert!(parse_info("Path=/tmp/x").is_none());
    }

    #[test]
    fn throwing_away_and_restoring_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        // A home trash on the same disk as the folder, as the home folder's would be.
        let home = dir.path().join("data/Trash");
        let work = dir.path().join("work");
        std::fs::create_dir_all(work.join("folder")).unwrap();
        std::fs::write(work.join("folder/file.txt"), "kept").unwrap();
        let trashes = [home.clone()];
        let parent =
            rustix::fs::open(&work, OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        trash(
            &home,
            parent.as_fd(),
            OsStr::new("folder"),
            &work.join("folder"),
        )
        .unwrap();
        assert!(!work.join("folder").exists());
        assert!(home.join("info/folder.trashinfo").is_file());
        let listed = list_in(&trashes);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, work.join("folder").display().to_string());
        assert_eq!(listed[0].kind, Kind::Folder);
        let item = find_in(&trashes, &listed[0].id).unwrap();
        restore(&item, parent.as_fd(), OsStr::new("folder")).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join("folder/file.txt")).unwrap(),
            "kept"
        );
        assert!(list_in(&trashes).is_empty());
        std::fs::write(work.join("gone"), "x").unwrap();
        trash(
            &home,
            parent.as_fd(),
            OsStr::new("gone"),
            &work.join("gone"),
        )
        .unwrap();
        std::fs::write(work.join("gone"), "y").unwrap();
        trash(
            &home,
            parent.as_fd(),
            OsStr::new("gone"),
            &work.join("gone"),
        )
        .unwrap();
        let listed = list_in(&trashes);
        assert_eq!(listed.len(), 2, "a second item of one name takes another");
        for item in listed {
            purge(&find_in(&trashes, &item.id).unwrap()).unwrap();
        }
        assert!(list_in(&trashes).is_empty());
        assert!(find_in(&trashes, "bm9wZQ.bm9wZQ").is_err());
    }

    #[test]
    fn a_trash_that_cannot_be_made_is_none() {
        let dir = tempfile::tempdir().unwrap();
        // Something not a trash folder where the trash would be, as a trash out of reach is.
        let home = dir.path().join("Trash");
        std::fs::write(&home, "not a folder").unwrap();
        std::fs::write(dir.path().join("kept"), "x").unwrap();
        let parent =
            rustix::fs::open(dir.path(), OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        let error = trash(
            &home,
            parent.as_fd(),
            OsStr::new("kept"),
            &dir.path().join("kept"),
        )
        .unwrap_err();
        assert!(matches!(error, FilesError::NoTrash(_)), "{error}");
        assert!(dir.path().join("kept").is_file());
    }

    #[test]
    fn a_name_taken_in_the_trash_or_too_long_still_goes() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("data/Trash");
        let work = dir.path().join("work");
        std::fs::create_dir_all(home.join("files")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        // Left in the trash by something else, with no info file.
        std::fs::write(home.join("files/gone"), "orphan").unwrap();
        std::fs::write(work.join("gone"), "mine").unwrap();
        let long = "n".repeat(250);
        std::fs::write(work.join(&long), "long").unwrap();
        let trashes = [home.clone()];
        let parent =
            rustix::fs::open(&work, OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        trash(
            &home,
            parent.as_fd(),
            OsStr::new("gone"),
            &work.join("gone"),
        )
        .unwrap();
        trash(&home, parent.as_fd(), OsStr::new(&long), &work.join(&long)).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("files/gone")).unwrap(),
            "orphan"
        );
        let mut listed = list_in(&trashes);
        listed.sort_by_key(|item| item.name.len());
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "gone");
        assert_eq!(listed[1].name, long, "the original name is kept");
        let item = find_in(&trashes, &listed[1].id).unwrap();
        restore(&item, parent.as_fd(), OsStr::new(&long)).unwrap();
        assert_eq!(std::fs::read_to_string(work.join(&long)).unwrap(), "long");
    }
}
