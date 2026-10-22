//! The config file, `~/.config/mekaweb/config.toml`, beside meka's `~/.config/meka/config.toml`:
//! where mekaweb listens and is reached, how it reaches meka, what push notifications are sent as,
//! and the terminal's settings. Paths may start with `~/`.

use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, bail};
use ipnet::IpNet;
use serde::Deserialize;
use url::Url;

/// How long a terminal nobody has used lives on, unless the config says otherwise.
const DEFAULT_TERMINAL_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

/// The config as written, before its paths are resolved and its values checked.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    listen: SocketAddr,
    public_origin: String,
    #[serde(default)]
    trusted_proxies: Vec<String>,
    state_dir: Option<String>,
    meka: RawMeka,
    /// Gone: Files browses anywhere, opening at a session's folder. Read only to say so.
    files: Option<toml::Value>,
    #[serde(default)]
    push: RawPush,
    #[serde(default)]
    terminal: RawTerminal,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMeka {
    url: String,
    token: Option<String>,
    token_file: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPush {
    subject: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTerminal {
    #[serde(default = "enabled")]
    enabled: bool,
    #[serde(default = "default_terminal_idle", with = "humantime_serde")]
    idle_timeout: Duration,
    shell: Option<String>,
}

impl Default for RawTerminal {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_timeout: DEFAULT_TERMINAL_IDLE,
            shell: None,
        }
    }
}

const fn enabled() -> bool {
    true
}

const fn default_terminal_idle() -> Duration {
    DEFAULT_TERMINAL_IDLE
}

/// The checked config.
#[derive(Debug, Clone)]
pub(crate) struct Config {
    /// Where mekaweb listens.
    pub(crate) listen: SocketAddr,
    /// The address people reach mekaweb at, without a trailing slash: the passkeys' site and what
    /// every write's `Origin` must be.
    pub(crate) public_origin: Url,
    /// Proxies whose client address headers are believed.
    pub(crate) trusted_proxies: Vec<IpNet>,
    /// Where mekaweb keeps its database.
    pub(crate) state_dir: PathBuf,
    /// How mekaweb reaches meka.
    pub(crate) meka: MekaConfig,
    /// Who push notifications come from, as Apple and the other push services want to be told.
    pub(crate) push_subject: Option<String>,
    /// The terminal's settings.
    pub(crate) terminal: TerminalConfig,
}

/// How mekaweb reaches meka.
#[derive(Debug, Clone)]
pub(crate) struct MekaConfig {
    /// meka's address, without a trailing slash.
    pub(crate) url: Url,
    /// A meka token with every scope, or where to read it.
    pub(crate) token: MekaToken,
}

/// Where meka's token comes from.
#[derive(Clone)]
pub(crate) enum MekaToken {
    /// Written in the config.
    Inline(String),
    /// Read from a file, and again at each check of meka, so a new token needs no restart.
    File(PathBuf),
}

// The token itself never reaches a log through the config's `Debug`.
impl std::fmt::Debug for MekaToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inline(_) => f.write_str("Inline(..)"),
            Self::File(path) => f.debug_tuple("File").field(path).finish(),
        }
    }
}

/// The terminal's settings.
#[derive(Debug, Clone)]
pub(crate) struct TerminalConfig {
    /// Whether terminals may be opened at all.
    pub(crate) enabled: bool,
    /// How long a terminal nobody is attached to or typing in lives on.
    pub(crate) idle_timeout: Duration,
    /// The shell to run, instead of the user's login shell.
    pub(crate) shell: Option<PathBuf>,
}

impl Config {
    /// The config at `path`.
    pub(crate) fn open(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("could not read the config at {}", path.display()))?;
        Self::parse(&text).with_context(|| format!("the config at {} is invalid", path.display()))
    }

    /// The config `text` holds.
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        let raw: RawConfig = toml::from_str(text)?;
        let public_origin = origin(&raw.public_origin, "public_origin")?;
        let trusted_proxies = raw
            .trusted_proxies
            .iter()
            .map(|proxy| parse_net(proxy))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let state_dir = match raw.state_dir {
            Some(dir) => expand(&dir)?,
            None => default_state_dir()?,
        };
        let meka_url = origin(&raw.meka.url, "meka.url")?;
        if raw.files.is_some() {
            bail!(
                "[[files.roots]] is no longer read: Files opens at a session's working directory and browses anywhere; remove it"
            );
        }
        let push_subject = raw
            .push
            .subject
            .map(|subject| subject.trim().to_owned())
            .filter(|subject| !subject.is_empty());
        if let Some(subject) = &push_subject
            && !(subject.starts_with("mailto:") || subject.starts_with("https://"))
        {
            bail!("push.subject must be a mailto: or https: address, which Apple insists on");
        }
        let shell = raw.terminal.shell.as_deref().map(expand).transpose()?;
        Ok(Self {
            listen: raw.listen,
            public_origin,
            trusted_proxies,
            state_dir,
            meka: MekaConfig {
                url: meka_url,
                token: match (raw.meka.token, raw.meka.token_file) {
                    (Some(_), Some(_)) => {
                        bail!("meka.token and meka.token_file are both set; give one")
                    }
                    (Some(token), None) => {
                        let token = token.trim();
                        if token.is_empty() {
                            bail!("meka.token is empty");
                        }
                        MekaToken::Inline(token.to_owned())
                    }
                    (None, Some(file)) => MekaToken::File(expand(&file)?),
                    (None, None) => bail!(
                        "give meka's token as meka.token, or a file holding it as meka.token_file"
                    ),
                },
            },
            push_subject,
            terminal: TerminalConfig {
                enabled: raw.terminal.enabled,
                idle_timeout: raw.terminal.idle_timeout,
                shell,
            },
        })
    }

    /// Whether people reach mekaweb over HTTPS, where its cookies are secure.
    pub(crate) fn is_https(&self) -> bool {
        self.public_origin.scheme() == "https"
    }

    /// `public_origin` as a browser writes it in `Origin`.
    pub(crate) fn origin(&self) -> String {
        self.public_origin.origin().ascii_serialization()
    }

    /// The meka token, as the config gives it or read from its file.
    pub(crate) fn meka_token(&self) -> anyhow::Result<String> {
        let file = match &self.meka.token {
            MekaToken::Inline(token) => return Ok(token.clone()),
            MekaToken::File(file) => file,
        };
        let token = std::fs::read_to_string(file)
            .with_context(|| format!("could not read the meka token at {}", file.display()))?;
        let token = token.trim().to_owned();
        if token.is_empty() {
            bail!("the meka token file {} is empty", file.display());
        }
        Ok(token)
    }

    /// The file holding meka's token, this config at `config` or the token file, if others than
    /// its owner may read it.
    pub(crate) fn exposed_token(&self, config: &Path) -> Option<PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let holder = match &self.meka.token {
            MekaToken::Inline(_) => config,
            MekaToken::File(file) => file,
        };
        std::fs::metadata(holder)
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o077 != 0)
            .then(|| holder.to_path_buf())
    }
}

/// `value` as an origin: a scheme and host, maybe a port, and nothing else.
fn origin(value: &str, key: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value.trim()).with_context(|| format!("{key} is not an address"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        bail!("{key} must be an http:// or https:// address");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        bail!("{key} must have no path, query or fragment");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("{key} must not carry credentials");
    }
    Ok(url)
}

/// A network or a single address.
fn parse_net(value: &str) -> anyhow::Result<IpNet> {
    let value = value.trim();
    if let Ok(net) = value.parse::<IpNet>() {
        return Ok(net);
    }
    let address: IpAddr = value
        .parse()
        .with_context(|| format!("{value:?} in trusted_proxies is not an address or network"))?;
    Ok(IpNet::from(address))
}

/// `path` with a leading `~/` made the home folder.
pub(crate) fn expand(path: &str) -> anyhow::Result<PathBuf> {
    if path == "~" {
        return home();
    }
    match path.strip_prefix("~/") {
        Some(rest) => Ok(home()?.join(rest)),
        None => Ok(PathBuf::from(path)),
    }
}

/// The user's home folder.
pub(crate) fn home() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .context("HOME is not set")
}

/// `$XDG_STATE_HOME/mekaweb`, or `~/.local/state/mekaweb`.
fn default_state_dir() -> anyhow::Result<PathBuf> {
    match std::env::var_os("XDG_STATE_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir).join("mekaweb")),
        None => Ok(home()?.join(".local/state/mekaweb")),
    }
}

/// `$XDG_CONFIG_HOME/mekaweb/config.toml`, or `~/.config/mekaweb/config.toml`.
pub(crate) fn default_path() -> anyhow::Result<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir).join("mekaweb/config.toml")),
        None => Ok(home()?.join(".config/mekaweb/config.toml")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
        listen = "127.0.0.1:8090"
        public_origin = "https://meka.example.com"
        state_dir = "/var/lib/mekaweb"

        [meka]
        url = "http://127.0.0.1:8080"
        token_file = "/etc/mekaweb/meka-token"
    "#;

    #[test]
    fn a_minimal_config_takes_the_defaults() {
        let config = Config::parse(MINIMAL).unwrap();
        assert_eq!(config.origin(), "https://meka.example.com");
        assert!(config.is_https());
        assert!(config.terminal.enabled);
        assert_eq!(config.terminal.idle_timeout, DEFAULT_TERMINAL_IDLE);
        assert!(config.push_subject.is_none());
    }

    #[test]
    fn an_origin_with_a_path_is_refused() {
        let text = MINIMAL.replace("https://meka.example.com", "https://example.com/meka");
        assert!(Config::parse(&text).is_err());
    }

    #[test]
    fn trusted_proxies_take_addresses_and_networks() {
        let text = MINIMAL.replace(
            "state_dir",
            "trusted_proxies = [\"127.0.0.1\", \"10.0.0.0/8\", \"::1\"]\nstate_dir",
        );
        let config = Config::parse(&text).unwrap();
        assert_eq!(config.trusted_proxies.len(), 3);
        assert!(config.trusted_proxies[1].contains(&"10.1.2.3".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn folder_roots_are_refused_with_a_reason() {
        let roots = format!("{MINIMAL}\n[[files.roots]]\nname = \"a\"\npath = \"/a\"\n");
        let error = format!("{:#}", Config::parse(&roots).unwrap_err());
        assert!(error.contains("no longer read"), "{error}");
    }

    #[test]
    fn a_push_subject_must_be_one_apple_accepts() {
        let bad = format!("{MINIMAL}\n[push]\nsubject = \"me@example.com\"\n");
        assert!(Config::parse(&bad).is_err());
        let good = format!("{MINIMAL}\n[push]\nsubject = \"mailto:me@example.com\"\n");
        assert_eq!(
            Config::parse(&good).unwrap().push_subject.as_deref(),
            Some("mailto:me@example.com")
        );
    }

    #[test]
    fn the_example_config_parses_with_its_optional_settings_or_without() {
        let example = include_str!("../../../config/mekaweb.toml");
        let config = Config::parse(example).unwrap();
        assert!(config.push_subject.is_none());
        // Every setting commented out, uncommented: `#key = value` and `#[table]` lines; all but
        // the inline token, which takes token_file's place rather than adding to it.
        let uncommented = example
            .lines()
            .map(|line| match line.strip_prefix('#') {
                Some(rest) if rest.starts_with("token = ") => line,
                Some(rest)
                    if rest.starts_with('[')
                        || rest.split_once(" = ").is_some_and(|(key, _)| {
                            key.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                        }) =>
                {
                    rest
                }
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let config = Config::parse(&uncommented).unwrap();
        assert_eq!(config.trusted_proxies.len(), 2);
        assert!(config.push_subject.is_some());
        assert_eq!(
            config.terminal.shell.as_deref(),
            Some(Path::new("/bin/bash"))
        );
    }

    #[test]
    fn meka_token_is_given_inline_or_in_a_file_not_both() {
        let inline = MINIMAL.replace(
            "token_file = \"/etc/mekaweb/meka-token\"",
            "token = \" secret \"",
        );
        let config = Config::parse(&inline).unwrap();
        assert_eq!(config.meka_token().unwrap(), "secret");
        assert!(
            !format!("{config:?}").contains("secret"),
            "the token stays out of the config's Debug"
        );
        let both = MINIMAL.replace(
            "token_file = \"/etc/mekaweb/meka-token\"",
            "token = \"secret\"\ntoken_file = \"/etc/mekaweb/meka-token\"",
        );
        assert!(Config::parse(&both).is_err());
        let neither = MINIMAL.replace("token_file = \"/etc/mekaweb/meka-token\"", "");
        assert!(Config::parse(&neither).is_err());
        let empty = MINIMAL.replace("token_file = \"/etc/mekaweb/meka-token\"", "token = \"  \"");
        assert!(Config::parse(&empty).is_err());
    }

    #[test]
    fn a_token_others_can_read_is_noticed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let inline = MINIMAL.replace(
            "token_file = \"/etc/mekaweb/meka-token\"",
            "token = \"secret\"",
        );
        std::fs::write(&path, &inline).unwrap();
        let mode = |mode| std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
        mode(0o644).unwrap();
        let config = Config::open(&path).unwrap();
        assert_eq!(config.exposed_token(&path), Some(path.clone()));
        mode(0o600).unwrap();
        assert_eq!(config.exposed_token(&path), None);
    }

    #[test]
    fn unknown_keys_are_refused() {
        let text = format!("{MINIMAL}\nlisten_port = 1\n");
        assert!(Config::parse(&text).is_err());
    }
}
