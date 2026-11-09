//! What git says of the repositories Files shows: the entries changed, new or ignored, and the
//! branch. It is read by running git itself, so it is what the agent and a terminal see, and from
//! git's porcelain v2 output, which git keeps the same from one version to the next.
//!
//! Files opens any folder, and a repository's own config can name programs that `git status`
//! runs: an fsmonitor hook, and filters it runs over files whose times changed, which is every
//! file in a repository just unpacked from an archive. Opening a folder is not to run anything,
//! so those a repository names for itself are blanked for each read; those the user's own config
//! names, such as Git LFS's, are kept. git is not let look into submodules either, which would
//! run what theirs name: a submodule shows as changed when its commit does, and inside it what
//! it holds shows from its own status. git takes the repository it is given, never one above it
//! or a bare one, and writes nothing: the index is not refreshed, so the agent's own git never
//! finds it locked.

use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::{io::AsyncReadExt, process::Command, sync::OnceCell};
use utoipa::ToSchema;

use crate::error::ApiError;

/// The oldest git with all that is used here: `GIT_CONFIG_COUNT` came in 2.31.
const MIN_VERSION: (u32, u32) = (2, 31);

/// How long git may take to read a repository's status.
const TIMEOUT: Duration = Duration::from_secs(10);

/// The most changes told. Past it, none are, rather than some of them.
pub(crate) const MAX_CHANGES: usize = 10_000;

/// The most of git's output read: far more than [`MAX_CHANGES`] take with long paths.
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// The most of git's errors kept, to say what went wrong.
const MAX_ERROR_BYTES: usize = 16 * 1024;

/// The most repositories whose last status is kept.
const MAX_KEPT: usize = 64;

/// The settings whose values are programs `git status` may run.
const PROGRAMS: &str = r"^(filter\..+\.(clean|process)|core\.fsmonitor)$";

/// Why git could not say how a repository stands.
#[derive(Debug, thiserror::Error)]
pub(crate) enum GitError {
    #[error("git 2.31 or newer is not installed")]
    Unavailable,
    #[error("{0} is not a git repository's folder")]
    NotARepository(String),
    #[error("git could not read {0}: {1}")]
    Failed(String, String),
}

impl From<GitError> for ApiError {
    fn from(error: GitError) -> Self {
        use axum::http::StatusCode;
        match error {
            GitError::Unavailable => Self::new(
                StatusCode::NOT_FOUND,
                "git-unavailable",
                "git is unavailable",
                error.to_string(),
            ),
            GitError::NotARepository(_) => Self::not_found(error.to_string()),
            GitError::Failed(..) => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "git-failed",
                "git failed",
                error.to_string(),
            ),
        }
    }
}

/// How an entry differs from the last commit, as Files marks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    /// Left in conflict by a merge.
    Conflicted,
}

/// An entry that differs from the last commit, or that git ignores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Change {
    /// Where it is in the repository, its names separated by `/`. A folder git tells of as a
    /// whole, new or ignored with all it holds, ends with `/`.
    pub(crate) path: String,
    pub(crate) kind: ChangeKind,
    /// Where a renamed entry was.
    pub(crate) from: Option<String>,
}

/// How a repository stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct GitStatus {
    /// The repository's folder, absolute.
    pub(crate) repo: String,
    /// Its git folder, absolute, which staging, committing and switching branches change.
    pub(crate) git_dir: Option<String>,
    /// The branch checked out; none when a commit is checked out on its own.
    pub(crate) branch: Option<String>,
    /// The commit checked out; none before the first.
    pub(crate) commit: Option<String>,
    /// The branch it follows, if any.
    pub(crate) upstream: Option<String>,
    /// How many commits it has that its upstream does not, and the other way around; none where
    /// the upstream is not there.
    pub(crate) ahead: Option<u32>,
    pub(crate) behind: Option<u32>,
    pub(crate) changes: Vec<Change>,
    /// Whether more changed than are told: past 10,000, none are.
    pub(crate) too_many: bool,
}

/// A repository's last status, and when reading it started.
struct Read {
    started: Instant,
    status: Arc<GitStatus>,
}

/// One repository's last status, held while the next is read.
type Slot = Arc<tokio::sync::Mutex<Option<Read>>>;

/// git, run for Files.
pub(crate) struct Git {
    /// Whether git is there and new enough, found out once.
    available: OnceCell<bool>,
    /// Each repository's last status. One is read at a time for each; those asked for while it is
    /// read are read again once, after it.
    repos: Mutex<HashMap<PathBuf, Slot>>,
    /// Set for git as it runs, after what Meka Studio was started with is let go of: tests point
    /// it at a config of their own.
    env: Vec<(OsString, OsString)>,
}

impl Git {
    pub(crate) fn new() -> Self {
        Self::with_env(Vec::new())
    }

    /// git, run with `env` set.
    pub(crate) fn with_env(env: Vec<(OsString, OsString)>) -> Self {
        Self {
            available: OnceCell::new(),
            repos: Mutex::new(HashMap::new()),
            env,
        }
    }

    /// Whether git is there and new enough.
    pub(crate) async fn available(&self) -> bool {
        *self
            .available
            .get_or_init(|| async {
                let mut command = self.command(None, &[]);
                command.arg("--version");
                match run(command).await {
                    Ok(output) if output.status.success() => {
                        new_enough(&String::from_utf8_lossy(&output.stdout))
                    }
                    Ok(_) | Err(_) => false,
                }
            })
            .await
    }

    /// The repository the folder `folder` is in: the nearest folder holding a `.git`, from
    /// `folder` up. None where git is not there to read it.
    pub(crate) async fn repository_of(&self, folder: PathBuf) -> Option<PathBuf> {
        if !self.available().await {
            return None;
        }
        tokio::task::spawn_blocking(move || {
            folder
                .ancestors()
                .find(|dir| has_dot_git(dir))
                .map(Path::to_path_buf)
        })
        .await
        .ok()
        .flatten()
    }

    /// How the repository whose folder is `repo` stands. One read already under way when this is
    /// asked for is waited for, and its status not taken: what changed while it ran may not be
    /// in it.
    pub(crate) async fn status(&self, repo: PathBuf) -> Result<Arc<GitStatus>, GitError> {
        let asked = Instant::now();
        if !self.available().await {
            return Err(GitError::Unavailable);
        }
        let checked = repo.clone();
        if !tokio::task::spawn_blocking(move || has_dot_git(&checked))
            .await
            .unwrap_or(false)
        {
            return Err(GitError::NotARepository(repo.display().to_string()));
        }
        let slot = self.slot(&repo);
        let mut last = slot.lock().await;
        if let Some(read) = last.as_ref()
            && read.started >= asked
        {
            return Ok(Arc::clone(&read.status));
        }
        let started = Instant::now();
        let status = Arc::new(self.read_status(&repo).await?);
        *last = Some(Read {
            started,
            status: Arc::clone(&status),
        });
        drop(last);
        Ok(status)
    }

    /// The slot `repo`'s status is kept in.
    fn slot(&self, repo: &Path) -> Slot {
        let mut repos = self.repos.lock().unwrap_or_else(PoisonError::into_inner);
        if !repos.contains_key(repo) && repos.len() >= MAX_KEPT {
            // Those no read holds go.
            repos.retain(|_, slot| Arc::strong_count(slot) > 1);
        }
        let slot = Arc::clone(repos.entry(repo.to_path_buf()).or_default());
        drop(repos);
        slot
    }

    async fn read_status(&self, repo: &Path) -> Result<GitStatus, GitError> {
        let failed = |detail: String| GitError::Failed(repo.display().to_string(), detail);
        let blanked = self.programs_to_blank(repo).await?;
        let mut command = self.command(Some(repo), &blanked);
        command.args([
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=normal",
            "--ignored=matching",
            "--ignore-submodules=dirty",
        ]);
        let output = run(command).await.map_err(failed)?;
        if !output.capped && !output.status.success() {
            return Err(failed(output.error()));
        }
        let repo = repo.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut status = parse_status(&output.stdout, output.capped);
            status
                .changes
                .retain(|change| !is_nested_repository(&repo, change));
            status.repo = repo.display().to_string();
            status.git_dir = git_dir(&repo).map(|dir| dir.display().to_string());
            status
        })
        .await
        .map_err(|error| failed(error.to_string()))
    }

    /// The settings to blank as `repo`'s status is read: each program `git status` may run that
    /// the repository names for itself, rather than the user's own config or the system's.
    async fn programs_to_blank(&self, repo: &Path) -> Result<Vec<(String, String)>, GitError> {
        let mut command = self.command(Some(repo), &[]);
        command.args(["config", "--show-scope", "-z", "--get-regexp", PROGRAMS]);
        let output = run(command)
            .await
            .map_err(|detail| GitError::Failed(repo.display().to_string(), detail))?;
        // 1 is for none set.
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        if !output.status.success() {
            return Err(GitError::Failed(repo.display().to_string(), output.error()));
        }
        Ok(blanking(&output.stdout))
    }

    /// git, run in `repo` with `config` set: only what this sets of git's environment, and git
    /// kept from finding another repository than `repo`.
    fn command(&self, repo: Option<&Path>, config: &[(String, String)]) -> Command {
        let mut command = Command::new("git");
        for (name, _) in std::env::vars_os() {
            if name
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(name);
            }
        }
        let config: Vec<(&str, &str)> = [("safe.bareRepository", "explicit")]
            .into_iter()
            .chain(
                config
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            )
            .collect();
        // Set apart from their values, so no name, however written, is read as part of one.
        command.env("GIT_CONFIG_COUNT", config.len().to_string());
        for (index, (key, value)) in config.iter().enumerate() {
            command.env(format!("GIT_CONFIG_KEY_{index}"), key);
            command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
        command.env("GIT_OPTIONAL_LOCKS", "0");
        command.arg("--no-optional-locks");
        if let Some(repo) = repo {
            if let Some(above) = repo.parent() {
                command.env("GIT_CEILING_DIRECTORIES", above);
            }
            command.arg("-C").arg(repo);
        }
        command.envs(self.env.iter().map(|(name, value)| (name, value)));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            /// Keeps git from opening a console window.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }
}

/// What git wrote, and how it ended.
struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Whether it wrote more than is read, and was stopped.
    capped: bool,
}

impl Output {
    /// What git said went wrong.
    fn error(&self) -> String {
        let said = String::from_utf8_lossy(&self.stderr);
        let said = said.trim();
        if said.is_empty() {
            format!("git ended with {}", self.status)
        } else {
            said.lines()
                .map(|line| line.trim_start_matches("fatal: "))
                .collect::<Vec<_>>()
                .join(" ")
        }
    }
}

/// Runs `command` for at most [`TIMEOUT`], reading at most [`MAX_OUTPUT_BYTES`] of what it writes;
/// past that it is stopped. Its errors are read all along, apart, so it never waits to write them.
async fn run(mut command: Command) -> Result<Output, String> {
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("git's output could not be read".to_owned());
    };
    let errors = tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut chunk = [0; 4096];
        while let Ok(read @ 1..) = stderr.read(&mut chunk).await {
            let room = MAX_ERROR_BYTES.saturating_sub(kept.len());
            kept.extend(chunk.iter().take(read.min(room)));
        }
        kept
    });
    let reading = async {
        let mut out = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES as u64 + 1)
            .read_to_end(&mut out)
            .await
            .map_err(|error| error.to_string())?;
        let capped = out.len() > MAX_OUTPUT_BYTES;
        if capped {
            out.truncate(MAX_OUTPUT_BYTES);
            child.start_kill().map_err(|error| error.to_string())?;
        }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        Ok(Output {
            status,
            stdout: out,
            stderr: errors.await.unwrap_or_default(),
            capped,
        })
    };
    // Dropped, git is stopped.
    tokio::time::timeout(TIMEOUT, reading)
        .await
        .map_err(|_| format!("git took longer than {} seconds", TIMEOUT.as_secs()))?
}

/// Whether `git --version`'s `said` is of a git new enough.
fn new_enough(said: &str) -> bool {
    let mut numbers = said
        .trim()
        .strip_prefix("git version ")
        .unwrap_or_default()
        .split(['.', ' '])
        .map(|part| part.parse::<u32>().ok());
    matches!(
        (numbers.next().flatten(), numbers.next().flatten()),
        (Some(major), Some(minor)) if (major, minor) >= MIN_VERSION
    )
}

/// Whether `dir` holds a `.git`, a folder or a file naming one.
fn has_dot_git(dir: &Path) -> bool {
    dir.join(".git").symlink_metadata().is_ok()
}

/// The git folder of the repository whose folder is `repo`: its `.git`, or the folder a `.git`
/// file names, as a linked worktree's and a submodule's do.
fn git_dir(repo: &Path) -> Option<PathBuf> {
    let dot_git = repo.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let mut text = String::new();
    std::io::Read::read_to_string(
        &mut std::io::Read::take(std::fs::File::open(&dot_git).ok()?, 4096),
        &mut text,
    )
    .ok()?;
    let named = text.lines().next()?.strip_prefix("gitdir:")?.trim();
    crate::files::resolve(&repo.join(named).to_string_lossy()).ok()
}

/// Whether `change` is a repository inside `repo`, which git tells of as a folder new as a whole.
fn is_nested_repository(repo: &Path, change: &Change) -> bool {
    change.kind == ChangeKind::Untracked
        && change
            .path
            .strip_suffix('/')
            .is_some_and(|folder| has_dot_git(&repo.join(folder)))
}

/// The settings to blank, from `git config --show-scope -z --get-regexp`'s `output`: each of
/// [`PROGRAMS`] set other than in the user's own config or the system's. A filter blanked is not
/// required either, which would have git fail for want of it.
fn blanking(output: &[u8]) -> Vec<(String, String)> {
    let mut blanked = Vec::new();
    let mut filters = HashSet::new();
    let mut fields = output.split(|byte| *byte == 0);
    while let (Some(scope), Some(setting)) = (fields.next(), fields.next()) {
        if matches!(scope, b"global" | b"system") {
            continue;
        }
        // The key, then its value after a newline, if it has one.
        let key = setting
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or_default();
        let key = String::from_utf8_lossy(key);
        if key == "core.fsmonitor" {
            blanked.push(("core.fsmonitor".to_owned(), "false".to_owned()));
        } else if let Some(name) = key
            .strip_prefix("filter.")
            .and_then(|rest| rest.rsplit_once('.'))
            .map(|(name, _)| name.to_owned())
            && filters.insert(name.clone())
        {
            blanked.push((format!("filter.{name}.clean"), String::new()));
            blanked.push((format!("filter.{name}.process"), String::new()));
            blanked.push((format!("filter.{name}.required"), "false".to_owned()));
        }
    }
    blanked
}

/// Reads `git status --porcelain=v2 -z --branch`'s `output`. `capped`, it was stopped partway, and
/// what changed is not told.
fn parse_status(output: &[u8], capped: bool) -> GitStatus {
    let mut status = GitStatus::default();
    let mut records = output.split(|byte| *byte == 0);
    // Stopped partway, the last record may be cut short; then none are told.
    let mut count = 0;
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(header) = text.strip_prefix("# ") {
            branch_header(&mut status, header);
            continue;
        }
        // A rename's record is followed by one with where it was.
        let from = text
            .starts_with("2 ")
            .then(|| records.next())
            .flatten()
            .map(|from| String::from_utf8_lossy(from).into_owned());
        count += 1;
        if capped || count > MAX_CHANGES {
            continue;
        }
        let change = match text.split_at_checked(2) {
            Some(("1 ", rest)) => ordinary(rest, 6).map(|(kind, path)| Change {
                path,
                kind,
                from: None,
            }),
            Some(("2 ", rest)) => ordinary(rest, 7).map(|(kind, path)| Change { path, kind, from }),
            Some(("u ", rest)) => rest.splitn(10, ' ').nth(9).map(|path| Change {
                path: path.to_owned(),
                kind: ChangeKind::Conflicted,
                from: None,
            }),
            Some(("? ", path)) => Some(Change {
                path: path.to_owned(),
                kind: ChangeKind::Untracked,
                from: None,
            }),
            Some(("! ", path)) => Some(Change {
                path: path.to_owned(),
                kind: ChangeKind::Ignored,
                from: None,
            }),
            _ => None,
        };
        status.changes.extend(change);
    }
    if capped || count > MAX_CHANGES {
        status.changes.clear();
        status.too_many = true;
    }
    status
}

/// An ordinary or renamed entry's kind and path, from `rest`, its record after its type: its two
/// states, staged and not, then `fields` more before its path.
fn ordinary(rest: &str, fields: usize) -> Option<(ChangeKind, String)> {
    let mut parts = rest.splitn(fields + 2, ' ');
    let states = parts.next()?.as_bytes();
    let path = parts.nth(fields)?;
    let kind = match (*states.first()?, *states.get(1)?) {
        // Not on the disk, whatever is staged.
        (_, b'D') | (b'D', _) => ChangeKind::Deleted,
        (b'R', _) => ChangeKind::Renamed,
        (b'A' | b'C', _) => ChangeKind::Added,
        _ => ChangeKind::Modified,
    };
    Some((kind, path.to_owned()))
}

/// Reads a `# branch.` header into `status`.
fn branch_header(status: &mut GitStatus, header: &str) {
    let Some((name, value)) = header.split_once(' ') else {
        return;
    };
    match name {
        "branch.oid" if value != "(initial)" => status.commit = Some(value.to_owned()),
        "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
        "branch.upstream" => status.upstream = Some(value.to_owned()),
        "branch.ab" => {
            let mut counts = value
                .split(' ')
                .map(|count| count.trim_start_matches(['+', '-']).parse::<u32>().ok());
            status.ahead = counts.next().flatten();
            status.behind = counts.next().flatten();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git status` output, with `|` for each NUL.
    fn output(text: &str) -> Vec<u8> {
        text.replace('|', "\0").into_bytes()
    }

    #[test]
    fn status_tells_each_kind_of_change_and_the_branch() {
        let status = parse_status(
            &output(concat!(
                "# branch.oid 0020e35|# branch.head main|# branch.upstream origin/main|",
                "# branch.ab +2 -1|",
                "1 A. N... 000000 100644 100644 0000000 8ba3a16 added.txt|",
                "1 MM N... 100644 100644 100644 5626abf 814f4a4 both.txt|",
                "1 .D N... 100644 100644 000000 5626abf 5626abf gone.txt|",
                "2 R. N... 100644 100644 100644 5626abf 5626abf R100 dir/new name.txt|old.txt|",
                "2 RM N... 100644 100644 100644 5626abf 5626abf R90 edited after.txt|before.txt|",
                "1 .M S.M. 160000 160000 160000 aaedf95 aaedf95 sub|",
                "u UU N... 100644 100644 100644 100644 df967b9 b19a1e9 950b81b clash.txt|",
                "? new folder/|",
                "! build/|",
                "! x.log|",
            )),
            false,
        );
        assert_eq!(status.commit.as_deref(), Some("0020e35"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (Some(2), Some(1)));
        let told: Vec<(&str, ChangeKind, Option<&str>)> = status
            .changes
            .iter()
            .map(|change| (change.path.as_str(), change.kind, change.from.as_deref()))
            .collect();
        assert_eq!(told, [
            ("added.txt", ChangeKind::Added, None),
            ("both.txt", ChangeKind::Modified, None),
            ("gone.txt", ChangeKind::Deleted, None),
            ("dir/new name.txt", ChangeKind::Renamed, Some("old.txt")),
            ("edited after.txt", ChangeKind::Renamed, Some("before.txt")),
            ("sub", ChangeKind::Modified, None),
            ("clash.txt", ChangeKind::Conflicted, None),
            ("new folder/", ChangeKind::Untracked, None),
            ("build/", ChangeKind::Ignored, None),
            ("x.log", ChangeKind::Ignored, None),
        ]);
        assert!(!status.too_many);
    }

    #[test]
    fn a_detached_or_new_branch_has_no_name_or_commit() {
        let detached = parse_status(&output("# branch.oid abc|# branch.head (detached)|"), false);
        assert_eq!(
            (detached.branch, detached.commit.as_deref()),
            (None, Some("abc"))
        );
        let new = parse_status(&output("# branch.oid (initial)|# branch.head main|"), false);
        assert_eq!((new.branch.as_deref(), new.commit), (Some("main"), None));
    }

    #[test]
    fn too_many_changes_tell_none_and_say_so() {
        let mut text = String::from("# branch.head main|");
        for index in 0..=MAX_CHANGES {
            text.push_str(&format!("? {index}.txt|"));
        }
        let status = parse_status(&output(&text), false);
        assert!(status.too_many);
        assert!(status.changes.is_empty());
        assert_eq!(status.branch.as_deref(), Some("main"));
        let cut = parse_status(&output("# branch.head main|? a.txt|? b.t"), true);
        assert!(cut.too_many);
        assert!(cut.changes.is_empty());
    }

    #[test]
    fn programs_a_repository_names_for_itself_are_blanked() {
        let blanked = blanking(&output(concat!(
            "global|filter.lfs.process\ngit-lfs filter-process|",
            "system|core.fsmonitor\ntrue|",
            "local|filter.x.clean\nsh -c evil|",
            "local|filter.x.process\nsh -c evil|",
            "worktree|filter.a=b.c.clean|",
            "local|core.fsmonitor\nsh -c evil|",
        )));
        assert_eq!(blanked, [
            ("filter.x.clean".to_owned(), String::new()),
            ("filter.x.process".to_owned(), String::new()),
            ("filter.x.required".to_owned(), "false".to_owned()),
            ("filter.a=b.c.clean".to_owned(), String::new()),
            ("filter.a=b.c.process".to_owned(), String::new()),
            ("filter.a=b.c.required".to_owned(), "false".to_owned()),
            ("core.fsmonitor".to_owned(), "false".to_owned()),
        ]);
    }

    /// Runs git in `dir` with `args`, under the config `global` alone, as a test sets a repository
    /// up.
    #[cfg(unix)]
    fn git(dir: &Path, global: &Path, args: &[&str]) {
        let done = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.org"])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            done.status.success(),
            "{}",
            String::from_utf8_lossy(&done.stderr)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_repository_runs_none_of_the_programs_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("gitconfig");
        std::fs::write(&global, "").unwrap();
        let git_for_tests = Git::with_env(vec![
            ("GIT_CONFIG_GLOBAL".into(), global.clone().into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ]);
        if !git_for_tests.available().await {
            return;
        }
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &global, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join(".gitattributes"), "a.txt filter=x\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &global, &["add", "-A"]);
        git(&repo, &global, &["commit", "-qm", "first"]);
        std::fs::create_dir(repo.join("inner")).unwrap();
        git(&repo.join("inner"), &global, &["init", "-q"]);
        git(&repo, &global, &["worktree", "add", "-q", "../linked"]);
        // What an archive could bring along in its `.git`.
        let ran = dir.path().join("ran");
        let program = format!("sh -c 'touch {}; cat'", ran.display());
        for (key, value) in [
            ("filter.x.clean", program.as_str()),
            ("filter.x.process", program.as_str()),
            ("filter.x.required", "true"),
            ("core.fsmonitor", program.as_str()),
        ] {
            git(&repo, &global, &["config", key, value]);
        }
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "").unwrap();
        std::fs::create_dir_all(repo.join("build/out")).unwrap();
        std::fs::write(repo.join("build/out/x"), "").unwrap();

        let status = git_for_tests.status(repo.clone()).await.unwrap();
        assert!(!ran.exists(), "a program the repository names ran");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.repo, repo.display().to_string());
        assert_eq!(
            status.git_dir.as_deref(),
            Some(repo.join(".git").display().to_string().as_str())
        );
        let told: Vec<(&str, ChangeKind)> = status
            .changes
            .iter()
            .map(|change| (change.path.as_str(), change.kind))
            .collect();
        // The repository inside is not told of as new.
        assert_eq!(told, [
            ("a.txt", ChangeKind::Modified),
            ("new.txt", ChangeKind::Untracked),
            ("build/", ChangeKind::Ignored),
        ]);
        // Nothing was written: git's index is as it was.
        assert!(!repo.join(".git/index.lock").exists());

        assert_eq!(
            git_for_tests.repository_of(repo.join("build/out")).await,
            Some(repo.clone())
        );
        assert_eq!(
            git_for_tests.repository_of(repo.join("inner")).await,
            Some(repo.join("inner"))
        );
        assert_eq!(git_for_tests.repository_of(dir.path().into()).await, None);
        // A linked worktree's git folder is in the repository's. git names it by its real path,
        // which on macOS is under `/private/var` where the temporary folder's is under `/var`.
        let linked = git_for_tests
            .status(dir.path().join("linked"))
            .await
            .unwrap();
        let linked_dir = linked.git_dir.as_deref().map(std::fs::canonicalize);
        assert_eq!(
            linked_dir.transpose().unwrap(),
            Some(std::fs::canonicalize(repo.join(".git/worktrees/linked")).unwrap())
        );
        assert!(matches!(
            git_for_tests.status(repo.join("build")).await,
            Err(GitError::NotARepository(_))
        ));
    }

    #[test]
    fn versions_from_2_31_are_new_enough() {
        assert!(new_enough("git version 2.56.0\n"));
        assert!(new_enough("git version 2.31.0.windows.1"));
        assert!(new_enough("git version 3.0.0"));
        assert!(!new_enough("git version 2.30.9"));
        assert!(!new_enough("not git"));
    }
}
