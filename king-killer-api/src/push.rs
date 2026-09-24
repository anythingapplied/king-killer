//! Web Push: telling a player it's their turn when their page isn't running.
//!
//! iOS suspends a backgrounded page almost immediately, so the page-only
//! notification in the client can't fire there. A push message is delivered by
//! the platform's push service to the site's service worker even while the page
//! is suspended.
//!
//! Implemented directly on RustCrypto rather than the `web-push` crate, which
//! needs OpenSSL (it doesn't build on Windows out of the box, and would add a
//! system dependency to the Docker image):
//!
//! * RFC 8291 - message encryption (`aes128gcm`): an ephemeral P-256 key,
//!   ECDH with the browser's key, HKDF with the browser's auth secret, one
//!   AES-128-GCM record.
//! * RFC 8292 - VAPID: the request is signed with the server's P-256 key as an
//!   ES256 JWT, so the push service knows who is sending.
//!
//! Configured by `VAPID_PRIVATE_KEY` (base64url, the raw 32-byte P-256 scalar;
//! `scripts/generate_vapid_keys.js` makes one) and `VAPID_SUBJECT` (a
//! `mailto:` or `https:` contact for the push service). Without them push is
//! simply off and everything else works.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A browser's push subscription, as `PushSubscription.toJSON()` shapes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionKeys {
    /// The browser's P-256 public key, base64url, uncompressed (65 bytes).
    pub p256dh: String,
    /// The browser's 16-byte authentication secret, base64url.
    pub auth: String,
}

/// Push services a subscription may point at.
///
/// The server makes an outgoing request to whatever endpoint a client
/// registers, so an unchecked endpoint would let anyone aim the server at an
/// arbitrary URL - including addresses only reachable from inside the host.
/// Real subscriptions only ever point at the browsers' push services.
const ALLOWED_PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",                // Chrome, Edge, Android
    "updates.push.services.mozilla.com", // Firefox
    "push.services.mozilla.com",
    "push.apple.com",       // Safari, iOS home-screen apps (web.push.apple.com)
    "notify.windows.com",   // legacy Edge / WNS
];

/// Checks a subscription is well-formed and points at a real push service.
pub fn validate(sub: &PushSubscription) -> Result<(), String> {
    let url = reqwest::Url::parse(&sub.endpoint).map_err(|_| "endpoint is not a URL".to_string())?;
    if url.scheme() != "https" {
        return Err("endpoint must be https".into());
    }
    let host = url.host_str().unwrap_or_default();
    let allowed = ALLOWED_PUSH_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if !allowed {
        return Err(format!("{host} is not a known push service"));
    }
    let key = B64.decode(&sub.keys.p256dh).map_err(|_| "p256dh is not base64url".to_string())?;
    PublicKey::from_sec1_bytes(&key).map_err(|_| "p256dh is not a P-256 key".to_string())?;
    let auth = B64.decode(&sub.keys.auth).map_err(|_| "auth is not base64url".to_string())?;
    if auth.len() != 16 {
        return Err("auth must be 16 bytes".into());
    }
    Ok(())
}

/// Encrypts `payload` for one subscription (RFC 8291, `aes128gcm`).
///
/// `as_secret` and `salt` are parameters so tests can pin them; `send` draws
/// both fresh for every message.
pub fn encrypt(
    payload: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let ua_key = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "bad browser key".to_string())?;
    let as_public = as_secret.public_key().to_sec1_point(false);
    let as_public = as_public.as_bytes();

    // ECDH, then fold in the browser's auth secret (RFC 8291 section 3.3).
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_key.as_affine());
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes().as_ref())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "hkdf".to_string())?;

    // Content-encryption key and nonce (RFC 8188 section 2.2 / 2.3).
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| "hkdf".to_string())?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| "hkdf".to_string())?;

    // A single record: the payload plus the 0x02 "last record" delimiter.
    let mut plaintext = payload.to_vec();
    plaintext.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| "aes key".to_string())?;
    let ciphertext = cipher
        .encrypt(&Nonce::from(nonce), plaintext.as_slice())
        .map_err(|_| "aes-gcm".to_string())?;

    // Header: salt | record size | key id length | key id (our public key).
    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// A fresh P-256 private key from the OS RNG (via `rand`, already a
/// dependency). A random 32 bytes is a valid scalar except with probability
/// around 2^-32, so the loop essentially never repeats.
pub fn random_secret_key() -> SecretKey {
    loop {
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

/// The server's VAPID identity plus an HTTP client to send with.
pub struct Vapid {
    signing_key: SigningKey,
    /// Uncompressed public key, base64url - what browsers subscribe against.
    pub public_key: String,
    subject: String,
    client: reqwest::Client,
}

/// What happened to one push.
#[derive(Debug, PartialEq)]
pub enum Delivery {
    Sent,
    /// The push service says the subscription no longer exists; drop it.
    Gone,
    Failed(String),
}

impl Vapid {
    /// From the environment, or `None` (push disabled) if not configured.
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("VAPID_PRIVATE_KEY").ok()?;
        let subject = std::env::var("VAPID_SUBJECT").ok()?;
        match Self::new(&key, &subject) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("VAPID_PRIVATE_KEY is set but unusable ({e}); push is disabled");
                None
            }
        }
    }

    pub fn new(private_key_b64: &str, subject: &str) -> Result<Self, String> {
        let raw = B64.decode(private_key_b64.trim()).map_err(|_| "not base64url".to_string())?;
        let secret = SecretKey::from_slice(&raw).map_err(|_| "not a P-256 private key".to_string())?;
        let public_key = B64.encode(secret.public_key().to_sec1_point(false).as_bytes());
        Ok(Vapid {
            signing_key: SigningKey::from(secret),
            public_key,
            subject: subject.to_string(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }

    /// The `Authorization: vapid t=..., k=...` value for one push service.
    pub fn authorization(&self, endpoint: &str) -> Result<String, String> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "bad endpoint".to_string())?;
        let audience = url.origin().ascii_serialization();
        let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + 12 * 60 * 60;
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = B64.encode(
            serde_json::json!({ "aud": audience, "exp": exp, "sub": self.subject }).to_string(),
        );
        let signing_input = format!("{header}.{claims}");
        let signature: Signature = self.signing_key.sign(signing_input.as_bytes());
        let jwt = format!("{signing_input}.{}", B64.encode(signature.to_bytes()));
        Ok(format!("vapid t={jwt}, k={}", self.public_key))
    }

    pub async fn send(&self, sub: &PushSubscription, payload: &[u8]) -> Delivery {
        match self.try_send(sub, payload).await {
            Ok(d) => d,
            Err(e) => Delivery::Failed(e),
        }
    }

    async fn try_send(&self, sub: &PushSubscription, payload: &[u8]) -> Result<Delivery, String> {
        let ua_public = B64.decode(&sub.keys.p256dh).map_err(|_| "bad p256dh".to_string())?;
        let auth = B64.decode(&sub.keys.auth).map_err(|_| "bad auth".to_string())?;
        let as_secret = random_secret_key();
        let mut salt = [0u8; 16];
        rand::fill(&mut salt);
        let body = encrypt(payload, &ua_public, &auth, &as_secret, &salt)?;

        let response = self
            .client
            .post(&sub.endpoint)
            .header("Authorization", self.authorization(&sub.endpoint)?)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            // A turn alert is worthless once the turn has moved on; don't let
            // the push service hold it for a device that's offline for hours.
            .header("TTL", "900")
            .header("Urgency", "high")
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        Ok(match status {
            200..=299 => Delivery::Sent,
            404 | 410 => Delivery::Gone,
            _ => Delivery::Failed(format!("push service answered {status}")),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    /// Decrypts as the browser would (RFC 8291 from the receiving side), so
    /// the round trip exercises every step `encrypt` takes.
    fn decrypt(body: &[u8], ua_secret: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        let id_len = body[20] as usize;
        let as_public = &body[21..21 + id_len];
        let ciphertext = &body[21 + id_len..];
        let ua_public = ua_secret.public_key().to_sec1_point(false);

        let shared = p256::ecdh::diffie_hellman(
            ua_secret.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(as_public).unwrap().as_affine(),
        );
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_public.as_bytes());
        info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes().as_ref()).expand(&info, &mut ikm).unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(&Nonce::from(nonce), ciphertext)
            .expect("authentic ciphertext");
        assert_eq!(plain.pop(), Some(2), "single record ends with the 0x02 delimiter");
        plain
    }

    fn browser() -> (SecretKey, Vec<u8>, [u8; 16]) {
        let secret = random_secret_key();
        let public = secret.public_key().to_sec1_point(false).as_bytes().to_vec();
        let mut auth = [0u8; 16];
        rand::fill(&mut auth);
        (secret, public, auth)
    }

    #[test]
    fn a_message_round_trips_through_the_browser_side() {
        let (ua_secret, ua_public, auth) = browser();
        let payload = br#"{"title":"King Killer - it's your turn","body":"Room ABC123"}"#;
        let body = encrypt(payload, &ua_public, &auth, &random_secret_key(), &[7u8; 16]).unwrap();

        assert_eq!(&body[..16], &[7u8; 16], "the salt leads the header");
        assert_eq!(&body[16..20], &4096u32.to_be_bytes(), "record size");
        assert_eq!(body[20], 65, "key id is the uncompressed server key");
        assert_eq!(decrypt(&body, &ua_secret, &auth), payload);
    }

    #[test]
    fn encryption_matches_the_reference_implementation_byte_for_byte() {
        // Produced by `http_ece` 1.x (the reference aes128gcm implementation,
        // by an author of RFC 8188/8291) with these fixed keys and salt:
        // browser private key = 32 x 0x11, server key = 32 x 0x22,
        // auth = 16 x 0x33, salt = 16 x 0x44, record size 4096. The round trip
        // above only proves `encrypt` agrees with its own mirror; this pins it
        // to an independent implementation of the spec.
        let ua_public = B64.decode("BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q").unwrap();
        let as_secret = SecretKey::from_slice(&[0x22; 32]).unwrap();
        let expected = B64.decode(
            "RERERERERERERERERERERAAAEABBBNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU6yQQesaFLBCKKInrlQtb8JeWxBpV8pj8pr8rnN8afmRZWG5wHG40iDDTojFbmUFEKcu5sE0AdWo5TusMZj8pjcFDdg0v_nNOTeWq54eo",
        )
        .unwrap();
        let payload = br#"{"title":"King Killer - it's your turn","body":"Room ABC123"}"#;

        let body = encrypt(payload, &ua_public, &[0x33; 16], &as_secret, &[0x44; 16]).unwrap();
        assert_eq!(body, expected);

        // And the browser side of this module decrypts the reference output.
        let ua_secret = SecretKey::from_slice(&[0x11; 32]).unwrap();
        assert_eq!(decrypt(&expected, &ua_secret, &[0x33; 16]), payload);
    }

    #[test]
    fn a_tampered_message_is_rejected() {
        let (ua_secret, ua_public, auth) = browser();
        let mut body = encrypt(b"hello", &ua_public, &auth, &random_secret_key(), &[1u8; 16]).unwrap();
        let last = body.len() - 1;
        body[last] ^= 1;
        let result = std::panic::catch_unwind(|| decrypt(&body, &ua_secret, &auth));
        assert!(result.is_err(), "GCM must catch a flipped bit");
    }

    #[test]
    fn each_message_uses_a_fresh_key_and_salt() {
        // `send` draws both per message; two encryptions of the same payload
        // must not be byte-identical.
        let (_, ua_public, auth) = browser();
        let a = encrypt(b"same", &ua_public, &auth, &random_secret_key(), &[1u8; 16]).unwrap();
        let b = encrypt(b"same", &ua_public, &auth, &random_secret_key(), &[2u8; 16]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn the_vapid_header_is_a_valid_es256_jwt_for_the_push_origin() {
        let key = B64.encode(random_secret_key().to_bytes());
        let vapid = Vapid::new(&key, "mailto:ops@example.com").unwrap();
        let auth = vapid.authorization("https://fcm.googleapis.com/fcm/send/abc123").unwrap();

        let rest = auth.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        assert_eq!(k, vapid.public_key);
        let (signing_input, sig) = jwt.rsplit_once('.').unwrap();
        let (_, claims) = signing_input.split_once('.').unwrap();

        let claims: serde_json::Value = serde_json::from_slice(&B64.decode(claims).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com", "audience is the push service origin");
        assert_eq!(claims["sub"], "mailto:ops@example.com");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let exp = claims["exp"].as_u64().unwrap();
        assert!(exp > now && exp <= now + 24 * 60 * 60, "expiry within the 24h the spec allows");

        let verifying = VerifyingKey::from_sec1_bytes(&B64.decode(&vapid.public_key).unwrap()).unwrap();
        let signature = Signature::from_slice(&B64.decode(sig).unwrap()).unwrap();
        verifying.verify(signing_input.as_bytes(), &signature).expect("signed by the published key");
    }

    fn sub(endpoint: &str) -> PushSubscription {
        let (_, public, auth) = browser();
        PushSubscription {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys { p256dh: B64.encode(public), auth: B64.encode(auth) },
        }
    }

    #[test]
    fn subscriptions_must_point_at_a_real_push_service() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/QGx",
        ] {
            assert_eq!(validate(&sub(ok)), Ok(()), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/fcm/send/x", // not https
            "https://example.com/push",              // not a push service
            "https://127.0.0.1/admin",               // aimed inside the host
            "https://fcm.googleapis.com.evil.test/x", // suffix trick
            "not a url",
        ] {
            assert!(validate(&sub(bad)).is_err(), "{bad} must be refused");
        }
    }

    /// A stand-in push service on an ephemeral port: records each request's
    /// headers and body, and answers with `status`.
    pub(crate) struct FakePushService {
        pub endpoint: String,
        pub received: std::sync::Arc<std::sync::Mutex<Vec<(axum::http::HeaderMap, Vec<u8>)>>>,
    }

    pub(crate) async fn fake_push_service(status: u16) -> FakePushService {
        use axum::{Router, body::Bytes, extract::State, http::HeaderMap, routing::post};
        type Log = std::sync::Arc<std::sync::Mutex<Vec<(HeaderMap, Vec<u8>)>>>;
        let received: Log = Default::default();
        let app = Router::new()
            .route(
                "/push/{id}",
                post(|State((log, status)): State<(Log, u16)>, headers: HeaderMap, body: Bytes| async move {
                    log.lock().unwrap().push((headers, body.to_vec()));
                    axum::http::StatusCode::from_u16(status).unwrap()
                }),
            )
            .with_state((received.clone(), status));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakePushService { endpoint: format!("http://{addr}/push/device1"), received }
    }

    /// A browser keypair plus a subscription aimed at `endpoint`.
    pub(crate) fn subscribed_browser(endpoint: &str) -> (SecretKey, [u8; 16], PushSubscription) {
        let (secret, public, auth) = browser();
        let sub = PushSubscription {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys { p256dh: B64.encode(public), auth: B64.encode(auth) },
        };
        (secret, auth, sub)
    }

    pub(crate) fn open(body: &[u8], ua_secret: &SecretKey, auth: &[u8]) -> Vec<u8> {
        decrypt(body, ua_secret, auth)
    }

    #[tokio::test]
    async fn send_posts_an_encrypted_signed_message_the_browser_can_read() {
        let service = fake_push_service(201).await;
        let (ua_secret, auth, sub) = subscribed_browser(&service.endpoint);
        let vapid = Vapid::new(&B64.encode(random_secret_key().to_bytes()), "mailto:ops@example.com").unwrap();

        assert_eq!(vapid.send(&sub, b"{\"title\":\"hi\"}").await, Delivery::Sent);

        let received = service.received.lock().unwrap();
        assert_eq!(received.len(), 1);
        let (headers, body) = &received[0];
        assert_eq!(headers["content-encoding"], "aes128gcm");
        assert_eq!(headers["ttl"], "900");
        assert_eq!(headers["urgency"], "high");
        let authorization = headers["authorization"].to_str().unwrap();
        assert!(authorization.starts_with("vapid t=") && authorization.ends_with(&format!(", k={}", vapid.public_key)));
        assert_eq!(open(body, &ua_secret, &auth), b"{\"title\":\"hi\"}");
    }

    #[tokio::test]
    async fn a_subscription_the_service_has_dropped_reports_gone() {
        for status in [404, 410] {
            let service = fake_push_service(status).await;
            let (_, _, sub) = subscribed_browser(&service.endpoint);
            let vapid = Vapid::new(&B64.encode(random_secret_key().to_bytes()), "mailto:ops@example.com").unwrap();
            assert_eq!(vapid.send(&sub, b"x").await, Delivery::Gone, "status {status}");
        }
        let service = fake_push_service(500).await;
        let (_, _, sub) = subscribed_browser(&service.endpoint);
        let vapid = Vapid::new(&B64.encode(random_secret_key().to_bytes()), "mailto:ops@example.com").unwrap();
        assert!(matches!(vapid.send(&sub, b"x").await, Delivery::Failed(_)), "other errors are not treated as gone");
    }

    #[test]
    fn a_bad_vapid_key_is_refused_up_front() {
        assert!(Vapid::new("not base64!", "mailto:a@b.c").is_err());
        assert!(Vapid::new(&B64.encode([0u8; 32]), "mailto:a@b.c").is_err(), "zero is not a valid scalar");
    }

    #[test]
    fn malformed_keys_are_refused() {
        let mut s = sub("https://fcm.googleapis.com/fcm/send/x");
        s.keys.auth = B64.encode([0u8; 8]);
        assert!(validate(&s).is_err(), "auth must be 16 bytes");
        let mut s = sub("https://fcm.googleapis.com/fcm/send/x");
        s.keys.p256dh = B64.encode([4u8; 65]);
        assert!(validate(&s).is_err(), "p256dh must be a point on the curve");
    }
}
