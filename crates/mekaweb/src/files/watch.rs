//! Folders watched for changes, so the interface can list one again when what it holds changes:
//! through notify, which watches with inotify on Linux and FSEvents on macOS. Windows is polled
//! every two seconds instead: watching a folder there holds it open, which keeps the folders above
//! it from being renamed, and a folder deleted from being made again, while it is shown.
//!
//! A folder is watched by its real path, its symlinks resolved, so two ways of naming it share one
//! watch, and has one watch however many streams follow it. Each stream sees its changes as a count
//! going up, so a burst of them reads as one. Opening or reading a file is not a change, or listing
//! a folder would change it; nor is an unfinished upload's writing, which only lands as a change
//! when it takes its name. A folder deleted or moved away ends its streams, and a stream following
//! its path again watches whatever is there by then.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use notify::{
    Event, EventKind, RecursiveMode, Watcher as _,
    event::{AccessKind, AccessMode, MetadataKind, ModifyKind},
};
use tokio::sync::watch;

use super::{FilesError, UPLOAD_PREFIX};

/// How often Windows looks at a folder followed.
#[cfg(windows)]
const POLL_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// The system's watcher.
#[cfg(not(windows))]
type SystemWatcher = notify::RecommendedWatcher;
#[cfg(windows)]
type SystemWatcher = notify::PollWatcher;

/// The folders watched, which the thread notify reports on looks in.
#[derive(Default)]
struct Watched {
    /// Each folder watched, by its real path.
    folders: HashMap<PathBuf, Followed>,
    /// Folders that went away, whose watches are to be taken away.
    gone: Vec<PathBuf>,
    /// The id the next folder watched takes.
    next: u64,
}

/// A folder watched.
struct Followed {
    /// Tells this watch from one of the same path made after it went away.
    id: u64,
    /// How many streams follow it.
    streams: usize,
    /// Counts its changes.
    changes: watch::Sender<u64>,
}

struct Inner {
    watched: Arc<Mutex<Watched>>,
    /// The system's watcher, made when first needed. It is held while a folder is added or taken
    /// away, apart from `watched`, which notify's thread waits for as it reports.
    system: Mutex<Option<SystemWatcher>>,
}

/// The folders watched for changes.
#[derive(Clone)]
pub(crate) struct Watcher(Arc<Inner>);

/// A folder followed for changes until this is dropped. Its changes end if the folder goes away.
pub(crate) struct Watching {
    /// Goes up as the folder changes.
    pub(crate) changes: watch::Receiver<u64>,
    path: PathBuf,
    id: u64,
    inner: Arc<Inner>,
}

impl Drop for Watching {
    fn drop(&mut self) {
        let inner = Arc::clone(&self.inner);
        let path = std::mem::take(&mut self.path);
        let id = self.id;
        // Taking a watch away waits on notify's thread, so it is done off the async runtime.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || inner.release(&path, id));
            }
            Err(_) => inner.release(&path, id),
        }
    }
}

impl Watcher {
    /// No folders watched yet.
    pub(crate) fn new() -> Self {
        Self(Arc::new(Inner {
            watched: Arc::new(Mutex::new(Watched::default())),
            system: Mutex::new(None),
        }))
    }

    /// Follows the folder `path` for changes. It blocks, adding the folder's watch.
    pub(crate) fn follow(&self, path: &Path) -> Result<Watching, FilesError> {
        let shown = path.display().to_string();
        // A folder, as listing it would find it, by the path the system reports it by.
        drop(super::Folder::open(path).map_err(|error| FilesError::io(error, &shown))?);
        let real = std::fs::canonicalize(path).map_err(|error| FilesError::io(error, &shown))?;
        let mut system = self.0.system.lock().unwrap_or_else(PoisonError::into_inner);
        let gone = std::mem::take(
            &mut self
                .0
                .watched
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .gone,
        );
        if let Some(watcher) = system.as_mut() {
            for path in gone {
                // A folder deleted took its watch with it.
                watcher.unwatch(&path).ok();
            }
        }
        let mut watched = self
            .0
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(followed) = watched.folders.get_mut(&real) {
            followed.streams += 1;
            let watching = Watching {
                changes: followed.changes.subscribe(),
                path: real,
                id: followed.id,
                inner: Arc::clone(&self.0),
            };
            return Ok(watching);
        }
        // Not held while notify starts watching: its thread may be waiting for it to report.
        drop(watched);
        let watcher = match &mut *system {
            Some(watcher) => watcher,
            empty @ None => empty.insert(system_watcher(Arc::clone(&self.0.watched), &shown)?),
        };
        watcher
            .watch(&real, RecursiveMode::NonRecursive)
            .map_err(|error| watch_error(error, &shown))?;
        let (changes, receiver) = watch::channel(0);
        let mut watched = self
            .0
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let id = watched.next;
        watched.next += 1;
        watched.folders.insert(real.clone(), Followed {
            id,
            streams: 1,
            changes,
        });
        // Held until the folder is in, so a stream following it at once finds it there.
        drop(watched);
        drop(system);
        Ok(Watching {
            changes: receiver,
            path: real,
            id,
            inner: Arc::clone(&self.0),
        })
    }

    /// How many folders are watched.
    #[cfg(test)]
    fn watched(&self) -> usize {
        self.0
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .folders
            .len()
    }
}

impl Inner {
    /// One stream fewer follows the watch `id` of `path`; with none left, it is taken away.
    fn release(&self, path: &Path, id: u64) {
        let mut system = self.system.lock().unwrap_or_else(PoisonError::into_inner);
        let mut watched = self.watched.lock().unwrap_or_else(PoisonError::into_inner);
        // Gone away, and maybe watched again since: its watch is taken away as the folder went.
        let Some(followed) = watched
            .folders
            .get_mut(path)
            .filter(|followed| followed.id == id)
        else {
            return;
        };
        followed.streams -= 1;
        if followed.streams > 0 {
            return;
        }
        watched.folders.remove(path);
        drop(watched);
        if let Some(watcher) = system.as_mut()
            && let Err(error) = watcher.unwatch(path)
        {
            tracing::debug!("could not stop watching {}: {error}", path.display());
        }
        drop(system);
    }
}

/// The system's watcher, telling `watched` of what it sees.
fn system_watcher(watched: Arc<Mutex<Watched>>, shown: &str) -> Result<SystemWatcher, FilesError> {
    #[cfg(not(windows))]
    let made = notify::recommended_watcher(report(watched));
    #[cfg(windows)]
    let made = notify::PollWatcher::new(
        report(watched),
        notify::Config::default().with_poll_interval(POLL_EVERY),
    );
    made.map_err(|error| watch_error(error, shown))
}

/// What notify calls with what it sees: each change counted for the folder it is in, or the
/// folder it is.
fn report(watched: Arc<Mutex<Watched>>) -> impl notify::EventHandler {
    move |event: notify::Result<Event>| {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                tracing::debug!("watching folders: {error}");
                return;
            }
        };
        let mut watched = watched.lock().unwrap_or_else(PoisonError::into_inner);
        let count = |followed: &Followed| {
            followed
                .changes
                .send_modify(|count| *count = count.wrapping_add(1));
        };
        // Changes were missed: any folder may have changed.
        if event.need_rescan() {
            watched.folders.values().for_each(count);
            return;
        }
        if !matters(event.kind) {
            return;
        }
        for path in &event.paths {
            let upload = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(UPLOAD_PREFIX));
            if upload {
                continue;
            }
            if let Some(followed) = path.parent().and_then(|parent| watched.folders.get(parent)) {
                count(followed);
            }
            if let Some(followed) = watched.folders.get(path) {
                count(followed);
                // The folder itself went away: its streams end, which the interface follows
                // again, and its watch is taken away when the next folder is watched.
                if !path.is_dir() {
                    watched.folders.remove(path);
                    watched.gone.push(path.clone());
                }
            }
        }
    }
}

/// Whether an event may change a folder's listing: opening or reading is not, but a file written
/// and closed is, its size now whole.
const fn matters(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_)
        | EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => false,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => true,
        EventKind::Other => true,
    }
}

/// Why a folder could not be watched.
fn watch_error(error: notify::Error, shown: &str) -> FilesError {
    match error.kind {
        notify::ErrorKind::PathNotFound => FilesError::NotFound(shown.to_owned()),
        notify::ErrorKind::MaxFilesWatch => FilesError::Refused(
            "the system's limit on folders watched is reached; raise it to see changes".to_owned(),
        ),
        notify::ErrorKind::Io(error) => FilesError::io(error, shown),
        notify::ErrorKind::Generic(_)
        | notify::ErrorKind::WatchNotFound
        | notify::ErrorKind::InvalidConfig(_) => {
            FilesError::Internal(anyhow::anyhow!("could not watch {shown}: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Waits for a change to `watching`'s folder; whether one came within `within`.
    async fn changed(watching: &mut Watching, within: Duration) -> bool {
        let came = tokio::time::timeout(within, watching.changes.changed())
            .await
            .is_ok_and(|changed| changed.is_ok());
        watching.changes.mark_unchanged();
        came
    }

    /// Lets changes made a moment ago arrive, and forgets them.
    async fn settle(watching: &mut Watching) {
        while changed(watching, Duration::from_millis(300)).await {}
    }

    /// Follows `path` with `watcher`.
    async fn follow(watcher: &Watcher, path: &Path) -> Result<Watching, FilesError> {
        let watcher = watcher.clone();
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || watcher.follow(&path))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_folder_followed_tells_of_what_changes_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        std::fs::write(path.join("existing.txt"), "x").unwrap();
        std::fs::create_dir(path.join("inner")).unwrap();
        let watcher = Watcher::new();
        let mut watching = follow(&watcher, &path).await.unwrap();
        let wait = Duration::from_secs(10);
        std::fs::write(path.join("new.txt"), "hello").unwrap();
        assert!(changed(&mut watching, wait).await, "a file made");
        settle(&mut watching).await;
        std::fs::read(path.join("existing.txt")).unwrap();
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 3);
        assert!(
            !changed(&mut watching, Duration::from_millis(500)).await,
            "reading is not a change"
        );
        std::fs::write(path.join(format!("{UPLOAD_PREFIX}x")), "part").unwrap();
        assert!(
            !changed(&mut watching, Duration::from_millis(500)).await,
            "an unfinished upload is not a change"
        );
        std::fs::rename(path.join(format!("{UPLOAD_PREFIX}x")), path.join("landed")).unwrap();
        assert!(changed(&mut watching, wait).await, "an upload landing");
        settle(&mut watching).await;
        std::fs::remove_file(path.join("existing.txt")).unwrap();
        assert!(changed(&mut watching, wait).await, "a file deleted");
    }

    #[tokio::test]
    async fn a_folder_has_one_watch_for_all_its_streams_and_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("real");
        std::fs::create_dir(&path).unwrap();
        let watcher = Watcher::new();
        let first = follow(&watcher, &path).await.unwrap();
        #[cfg(unix)]
        let mut second = {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            follow(&watcher, &link).await.unwrap()
        };
        #[cfg(not(unix))]
        let mut second = follow(&watcher, &path).await.unwrap();
        assert_eq!(
            watcher.watched(),
            1,
            "one watch, however the folder is named"
        );
        drop(first);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(watcher.watched(), 1, "one stream still follows it");
        std::fs::write(path.join("a"), "a").unwrap();
        assert!(changed(&mut second, Duration::from_secs(10)).await);
        drop(second);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(watcher.watched(), 0);
        assert!(matches!(
            follow(&watcher, &path.join("missing")).await,
            Err(FilesError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn a_folder_deleted_ends_its_streams_and_is_watched_afresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("build");
        std::fs::create_dir(&path).unwrap();
        let watcher = Watcher::new();
        let mut watching = follow(&watcher, &path).await.unwrap();
        std::fs::remove_dir(&path).unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(10), async {
            while watching.changes.changed().await.is_ok() {}
        })
        .await;
        assert!(ended.is_ok(), "the stream ends with its folder");
        std::fs::create_dir(&path).unwrap();
        let mut again = follow(&watcher, &path).await.unwrap();
        drop(watching);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            watcher.watched(),
            1,
            "an old stream ending leaves the new watch"
        );
        std::fs::write(path.join("out.js"), "x").unwrap();
        assert!(changed(&mut again, Duration::from_secs(10)).await);
    }
}
