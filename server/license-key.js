'use strict';

// Ed25519 public key (SPKI DER, base64) that verifies the licence certificates signed by the
// `license` Edge Function (pixelqg-site/docs/ACCOUNTS.md, « Certificate format »).
// Only the public half lives here: the private key never ships with the app.

module.exports = Object.freeze({
  LICENSE_PUBLIC_KEY: 'MCowBQYDK2VwAyEAi6ECBEikU3CZ27dJtxjpYAB5E4bTn2VPgwc+rNJcGnw=',
});
