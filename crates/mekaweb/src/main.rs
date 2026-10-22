//! mekaweb: the web interface for meka, served from the meka host. It signs its one user in,
//! passes their requests to meka on loopback, and adds what meka leaves to the host: Files, a
//! terminal, push notifications, and meka's status.

#[cfg(not(target_os = "linux"))]
compile_error!("mekaweb runs on Linux: Files reads /proc and moves with renameat2");

mod api;
mod app;
mod auth;
mod config;
mod error;
mod files;
mod meka;
mod proxy;
mod push;
mod sse;
mod store;
mod terminal;
mod web;

#[cfg(test)]
mod tests;

use std::{
    io::{BufRead, IsTerminal},
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
};

use anyhow::{Context, bail};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    auth::password::{Hasher, check_password},
    config::{Config, MekaToken},
    store::Store,
};

/// The web interface for meka, served from the meka host
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// The config file [default: ~/.config/mekaweb/config.toml]
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve mekaweb
    Serve,
    /// Check the config and say what it sets up
    Check,
    /// Manage the user who signs in
    #[command(subcommand)]
    User(UserCommand),
    /// Print the API's OpenAPI document
    Openapi,
}

#[derive(Subcommand)]
enum UserCommand {
    /// Add the user, asking for their password
    Add {
        /// The username to sign in with
        username: String,
        /// Read the password from standard input rather than asking for it
        #[arg(long)]
        password_stdin: bool,
    },
    /// Set the user's password, asking for it, and sign every device out
    Passwd {
        /// Read the password from standard input rather than asking for it
        #[arg(long)]
        password_stdin: bool,
        /// Leave the devices signed in
        #[arg(long)]
        keep_devices: bool,
    },
    /// Remove all of the user's passkeys, for when they are lost, and sign every device out
    ResetPasskeys,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(run(cli))
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    if matches!(cli.command, Command::Openapi) {
        println!("{}", api::openapi().to_pretty_json()?);
        return Ok(());
    }
    let path = match cli.config {
        Some(path) => path,
        None => config::default_path()?,
    };
    let config = Config::open(&path)?;
    match cli.command {
        Command::Openapi => Ok(()),
        Command::Check => check(&config, &path),
        Command::Serve => {
            if let Some(file) = config.exposed_token(&path) {
                tracing::warn!(
                    "{} holds meka's token and others can read it; run `chmod 600` on it",
                    file.display()
                );
            }
            let store = open_store(&config)?;
            if store.user().await?.is_none() {
                tracing::warn!(
                    "nobody can sign in yet: add the user with `mekaweb user add <username>`"
                );
            }
            let app = app::App::open(config, store).await?;
            app::serve(app).await
        }
        Command::User(command) => user(&config, command).await,
    }
}

/// Opens the database in the state folder, making the folder if it is not there.
fn open_store(config: &Config) -> anyhow::Result<Store> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&config.state_dir)
        .with_context(|| format!("could not make {}", config.state_dir.display()))?;
    Store::open(&config.state_dir.join("mekaweb.db"))
}

fn check(config: &Config, path: &std::path::Path) -> anyhow::Result<()> {
    println!("Listens on {}, for {}", config.listen, config.origin());
    if !config.is_https() && config.public_origin.host_str() != Some("localhost") {
        println!(
            "  Warning: passkeys need HTTPS, or localhost; this address signs in with a password only."
        );
    }
    println!("State in {}", config.state_dir.display());
    println!("meka at {}", config.meka.url);
    match (config.meka_token(), &config.meka.token) {
        (Ok(_), MekaToken::Inline(_)) => println!("  token given in the config"),
        (Ok(_), MekaToken::File(file)) => println!("  token read from {}", file.display()),
        (Err(error), _) => println!("  Problem: {error:#}"),
    }
    if let Some(file) = config.exposed_token(path) {
        println!(
            "  Warning: {} holds meka's token and others can read it; run `chmod 600` on it.",
            file.display()
        );
    }
    println!(
        "Terminal: {}",
        if config.terminal.enabled { "on" } else { "off" }
    );
    match &config.push_subject {
        Some(subject) => println!("Push notifications: from {subject}"),
        None => println!("Push notifications: off (set push.subject)"),
    }
    Ok(())
}

async fn user(config: &Config, command: UserCommand) -> anyhow::Result<()> {
    let store = open_store(config)?;
    let hasher = Hasher::new()?;
    match command {
        UserCommand::Add {
            username,
            password_stdin,
        } => {
            if let Some(user) = store.user().await? {
                bail!(
                    "the user {:?} was added already; mekaweb has one user. Set their password with `mekaweb user passwd`.",
                    user.username
                );
            }
            let username = username.trim().to_owned();
            if username.is_empty() || username.chars().count() > 64 {
                bail!("a username is 1 to 64 characters");
            }
            let password = read_password(&username, password_stdin)?;
            store
                .add_user(&username, &hasher.hash(&password).await?)
                .await?;
            println!("Added {username}. Sign in at {}.", config.origin());
        }
        UserCommand::Passwd {
            password_stdin,
            keep_devices,
        } => {
            let user = store
                .user()
                .await?
                .context("there is no user yet; add one with `mekaweb user add <username>`")?;
            let password = read_password(&user.username, password_stdin)?;
            store
                .set_password(user.id, &hasher.hash(&password).await?)
                .await?;
            println!("The password of {} is set.", user.username);
            if !keep_devices {
                let count = store.delete_other_sessions(user.id, None).await?;
                println!("Devices signed out: {count}.");
            }
        }
        UserCommand::ResetPasskeys => {
            let user = store.user().await?.context("there is no user yet")?;
            let mut removed = 0;
            for passkey in store.passkeys(user.id).await? {
                if store.delete_passkey(user.id, &passkey.id).await? {
                    removed += 1;
                }
            }
            // A lost passkey may have been lost with a device signed in.
            let count = store.delete_other_sessions(user.id, None).await?;
            println!(
                "Passkeys removed: {removed}. Devices signed out: {count}. Sign in with the password to add new ones."
            );
        }
    }
    Ok(())
}

/// A new password for `username`: asked for twice on a terminal, or read from standard input.
fn read_password(username: &str, from_stdin: bool) -> anyhow::Result<String> {
    let password = if from_stdin || !std::io::stdin().is_terminal() {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        line.trim_end_matches(['\r', '\n']).to_owned()
    } else {
        let first = rpassword::prompt_password("Password: ")?;
        let second = rpassword::prompt_password("Again: ")?;
        if first != second {
            bail!("the two passwords differ");
        }
        first
    };
    check_password(&password, username).map_err(|problem| anyhow::anyhow!("{problem}"))?;
    Ok(password)
}
