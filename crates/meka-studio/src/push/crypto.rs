//! Web Push's cryptography: a message encrypted for one browser as RFC 8291 says (`aes128gcm`, a
//! fresh key pair and salt each time, so the push service relays what it cannot read), and the
//! VAPID token of RFC 8292 that tells the push service who sends it.

use aes_gcm::{
    Aes128Gcm, KeyInit,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer},
};
use sha2::Sha256;

/// The record size written in the header: one record holds the whole message.
const RECORD_SIZE: u32 = 4096;

/// The largest message that fits one record, after its padding delimiter and the tag.
pub(crate) const MAX_PAYLOAD_BYTES: usize = 3_000;

/// How long a VAPID token is good for: at most a day, as RFC 8292 allows.
const TOKEN_SECONDS: i64 = 12 * 60 * 60;

/// A new random P-256 secret key.
pub(crate) fn random_key() -> anyhow::Result<SecretKey> {
    loop {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no randomness: {error}"))?;
        // A few values are not valid keys; another draw is.
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return Ok(key);
        }
    }
}

/// A key's public half, uncompressed, as browsers and push services take it.
pub(crate) fn public_bytes(key: &SecretKey) -> Vec<u8> {
    key.public_key().to_sec1_bytes().into_vec()
}

/// A browser's subscription keys, as the browser gave them in URL-safe base64.
#[derive(Debug, Clone)]
pub(crate) struct Receiver {
    /// Its public key, uncompressed.
    pub(crate) public: Vec<u8>,
    /// Its authentication secret.
    pub(crate) auth: Vec<u8>,
}

impl Receiver {
    /// The keys a browser gave as `p256dh` and `auth`.
    pub(crate) fn from_base64(p256dh: &str, auth: &str) -> anyhow::Result<Self> {
        let public = URL_SAFE_NO_PAD.decode(p256dh.trim_end_matches('='))?;
        let auth = URL_SAFE_NO_PAD.decode(auth.trim_end_matches('='))?;
        PublicKey::from_sec1_bytes(&public)
            .map_err(|_| anyhow::anyhow!("the subscription's public key is not a P-256 point"))?;
        if auth.len() != 16 {
            anyhow::bail!("the subscription's auth secret is not 16 bytes");
        }
        Ok(Self { public, auth })
    }
}

/// `message` encrypted for `receiver`, as the body of a push.
pub(crate) fn encrypt(message: &[u8], receiver: &Receiver) -> anyhow::Result<Vec<u8>> {
    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt).map_err(|error| anyhow::anyhow!("no randomness: {error}"))?;
    encrypt_with(message, receiver, &random_key()?, salt)
}

/// [`encrypt`] with a given sender key and salt, for the RFC's example.
fn encrypt_with(
    message: &[u8],
    receiver: &Receiver,
    sender: &SecretKey,
    salt: [u8; 16],
) -> anyhow::Result<Vec<u8>> {
    if message.len() > MAX_PAYLOAD_BYTES {
        anyhow::bail!("a push message is at most {MAX_PAYLOAD_BYTES} bytes");
    }
    let receiver_key = PublicKey::from_sec1_bytes(&receiver.public)
        .map_err(|_| anyhow::anyhow!("the subscription's public key is not a P-256 point"))?;
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), receiver_key.as_affine());
    let sender_public = public_bytes(sender);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&receiver.public);
    key_info.extend_from_slice(&sender_public);
    let mut ikm = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(&receiver.auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| anyhow::anyhow!("HKDF refused its length"))?;
    let derived = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut key = [0_u8; 16];
    derived
        .expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .map_err(|_| anyhow::anyhow!("HKDF refused its length"))?;
    let mut nonce = [0_u8; 12];
    derived
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| anyhow::anyhow!("HKDF refused its length"))?;
    let mut plaintext = message.to_vec();
    // The last record's delimiter, with no padding.
    plaintext.push(2);
    let cipher =
        Aes128Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("AES-GCM refused its key"))?;
    let nonce = aes_gcm::Nonce::try_from(&nonce[..])
        .map_err(|_| anyhow::anyhow!("AES-GCM refused its nonce"))?;
    let ciphertext = cipher
        .encrypt(&nonce, Payload {
            msg: &plaintext,
            aad: b"",
        })
        .map_err(|_| anyhow::anyhow!("AES-GCM could not encrypt"))?;
    let mut body = Vec::with_capacity(16 + 4 + 1 + sender_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(u8::try_from(sender_public.len())?);
    body.extend_from_slice(&sender_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// The `Authorization` header that signs a push to `endpoint` with `key`, as `subject`, at
/// `now` (seconds since the epoch).
pub(crate) fn vapid(
    endpoint: &url::Url,
    key: &SecretKey,
    subject: &str,
    now: i64,
) -> anyhow::Result<String> {
    let audience = endpoint.origin().ascii_serialization();
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::json!({ "aud": audience, "exp": now + TOKEN_SECONDS, "sub": subject })
            .to_string(),
    );
    let input = format!("{header}.{claims}");
    let signature: Signature = SigningKey::from(key).sign(input.as_bytes());
    let token = format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));
    Ok(format!(
        "vapid t={token}, k={}",
        URL_SAFE_NO_PAD.encode(public_bytes(key))
    ))
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::{VerifyingKey, signature::Verifier};

    use super::*;

    fn decode(text: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(text).unwrap()
    }

    /// The example in RFC 8291, section 5.
    #[test]
    fn the_rfc_example_encrypts_to_its_message() {
        let receiver = Receiver::from_base64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
        )
        .unwrap();
        let sender =
            SecretKey::from_slice(&decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(public_bytes(&sender)),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let salt: [u8; 16] = decode("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(
            b"When I grow up, I want to be a watermelon",
            &receiver,
            &sender,
            salt,
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn a_vapid_token_verifies_with_its_key() {
        let key = random_key().unwrap();
        let endpoint = url::Url::parse("https://web.push.apple.com/QGuQyavXutnMH").unwrap();
        let header = vapid(&endpoint, &key, "mailto:me@example.com", 1_700_000_000).unwrap();
        let token = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let mut parts = token.split('.');
        let (head, claims, signature) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        let claims: serde_json::Value = serde_json::from_slice(&decode(claims)).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["sub"], "mailto:me@example.com");
        assert_eq!(claims["exp"], 1_700_000_000 + TOKEN_SECONDS);
        let signature = Signature::from_slice(&decode(signature)).unwrap();
        VerifyingKey::from(&SigningKey::from(&key))
            .verify(
                format!("{head}.{}", token.split('.').nth(1).unwrap()).as_bytes(),
                &signature,
            )
            .unwrap();
    }
}
