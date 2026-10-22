//! Passwords: the rules a new one meets, and hashing them with Argon2id at OWASP's minimum (19 MiB,
//! two passes, one lane). A hash holds its memory while it runs, so only a few run at once and a
//! flood of sign-ins waits its turn.

use std::sync::Arc;

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use tokio::sync::{OnceCell, Semaphore};

/// The shortest password.
pub(crate) const MIN_PASSWORD_CHARS: usize = 10;

/// The longest password.
pub(crate) const MAX_PASSWORD_CHARS: usize = 128;

/// Memory per hash, in KiB.
const HASH_MEMORY_KIB: u32 = 19 * 1024;

/// Passes per hash.
const HASH_PASSES: u32 = 2;

/// Hashes that run at once.
const CONCURRENT_HASHES: usize = 2;

/// Why a password cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum PasswordProblem {
    #[error("a password is at least 10 characters long")]
    Short,
    #[error("a password is at most 128 characters long")]
    Long,
    #[error("a password cannot be the username")]
    Username,
}

/// Whether `password` may be the password of `username`: 10 to 128 characters, and not the
/// username. Nothing more is asked of it, so a password manager's choice or a long phrase passes.
pub(crate) fn check_password(password: &str, username: &str) -> Result<(), PasswordProblem> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(PasswordProblem::Short);
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(PasswordProblem::Long);
    }
    if password.to_lowercase() == username.to_lowercase() {
        return Err(PasswordProblem::Username);
    }
    Ok(())
}

/// Hashes passwords and checks them against their hashes, a few at a time.
pub(crate) struct Hasher {
    params: Params,
    permits: Arc<Semaphore>,
    /// A hash of nothing anyone knows, checked against when there is no user, so a wrong username
    /// takes as long to refuse as a wrong password.
    decoy: OnceCell<String>,
}

impl Hasher {
    /// A hasher with mekaweb's settings.
    pub(crate) fn new() -> anyhow::Result<Self> {
        let params = Params::new(HASH_MEMORY_KIB, HASH_PASSES, 1, None)
            .map_err(|error| anyhow::anyhow!("bad Argon2 settings: {error}"))?;
        Ok(Self {
            params,
            permits: Arc::new(Semaphore::new(CONCURRENT_HASHES)),
            decoy: OnceCell::new(),
        })
    }

    /// `password`, hashed with a new salt, as a PHC string.
    pub(crate) async fn hash(&self, password: &str) -> anyhow::Result<String> {
        let password = password.to_owned();
        let argon2 = self.argon2();
        self.run(move || {
            argon2
                .hash_password(password.as_bytes())
                .map(|hash| hash.to_string())
                .map_err(|error| anyhow::anyhow!("could not hash a password: {error}"))
        })
        .await
    }

    /// Whether `password` is the one `hash` was made from. Without a hash the answer is no, after
    /// as long as a real check takes.
    pub(crate) async fn verify(&self, password: &str, hash: Option<&str>) -> anyhow::Result<bool> {
        let (hash, real) = match hash {
            Some(hash) => (hash.to_owned(), true),
            None => (self.decoy().await?.to_owned(), false),
        };
        let password = password.to_owned();
        let argon2 = self.argon2();
        let matches = self
            .run(move || {
                Ok(argon2
                    .verify_password(password.as_bytes(), hash.as_str())
                    .is_ok())
            })
            .await?;
        Ok(real && matches)
    }

    /// Makes the decoy hash now, so the first wrong username is not refused slower than a wrong
    /// password.
    pub(crate) async fn prepare(&self) -> anyhow::Result<()> {
        self.decoy().await.map(|_| ())
    }

    async fn decoy(&self) -> anyhow::Result<&str> {
        self.decoy
            .get_or_try_init(|| async { self.hash(&super::random_token()?).await })
            .await
            .map(String::as_str)
    }

    fn argon2(&self) -> Argon2<'static> {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, self.params.clone())
    }

    /// Runs `work` off the async runtime once a hashing slot is free.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let permit = Arc::clone(&self.permits).acquire_owned().await?;
        tokio::task::spawn_blocking(move || {
            let done = work();
            drop(permit);
            done
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_is_long_enough_and_not_the_username() {
        assert_eq!(check_password("short", "ada"), Err(PasswordProblem::Short));
        assert_eq!(
            check_password(&"x".repeat(129), "ada"),
            Err(PasswordProblem::Long)
        );
        assert_eq!(
            check_password("Ada_Lovelace", "ada_lovelace"),
            Err(PasswordProblem::Username)
        );
        assert_eq!(check_password("correct horse battery", "ada"), Ok(()));
        assert_eq!(
            check_password("いろはにほへとちりぬるを", "ada"),
            Ok(()),
            "characters count, not bytes"
        );
    }

    #[tokio::test]
    async fn a_hash_matches_its_password_alone() {
        let hasher = Hasher::new().unwrap();
        let hash = hasher.hash("correct horse battery").await.unwrap();
        assert!(
            hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
            "{hash}"
        );
        assert!(
            hasher
                .verify("correct horse battery", Some(&hash))
                .await
                .unwrap()
        );
        assert!(
            !hasher
                .verify("correct horse battery!", Some(&hash))
                .await
                .unwrap()
        );
        assert!(!hasher.verify("correct horse battery", None).await.unwrap());
    }
}
