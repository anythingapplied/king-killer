#!/usr/bin/env node
// Generates a VAPID key pair for Web Push (see king-killer-api/src/push.rs).
//
//   node scripts/generate_vapid_keys.js
//
// Prints the two settings the server reads. The private key is a secret: set
// it with `fly secrets set` (never commit it). The public key is derived from
// it by the server and handed to browsers at GET /api/push/key, so it only
// appears here for reference.
//
// Changing the private key invalidates every existing browser subscription;
// players re-subscribe the next time they turn notifications on.

const crypto = require('node:crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const priv = privateKey.export({ format: 'jwk' });
const pub = publicKey.export({ format: 'jwk' });

// Raw 32-byte scalar, base64url - what VAPID_PRIVATE_KEY expects.
const privateB64 = priv.d;
// Uncompressed point (0x04 | x | y), base64url - for reference only.
const publicB64 = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
]).toString('base64url');

console.log(`VAPID_PRIVATE_KEY=${privateB64}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com   # change to a contact address`);
console.log(`# public key (derived by the server; for reference): ${publicB64}`);
