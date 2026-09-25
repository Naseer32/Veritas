import crypto from "crypto";

const PUB_X = "29366a32d7ce36862f962bf559a0328ea82b880f877d5cca6ea5cbdc39957da2";
const PUB_Y = "8606ac00eda2517f8d584cccd5f9b5caa991f59171d5da8a183119a4524c14df";
const b64u = (hex) => Buffer.from(hex, "hex").toString("base64url");
const EXPIRY_SECONDS = 300;

function loadKey() {
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "secp256k1", x: b64u(PUB_X), y: b64u(PUB_Y), d: b64u(process.env.ATTESTATION_KEY_D || "") },
    format: "jwk",
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method" });
  const { token, address, site_id, evidence_json } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "no token" });
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ success: false, error: "invalid address" });
  if (!site_id || typeof evidence_json !== "string") return res.status(400).json({ success: false, error: "missing site_id or evidence_json" });

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return res.status(500).json({ success: false, error: "server not configured" });

  let key;
  try {
    key = loadKey();
  } catch (e) {
    return res.status(500).json({ success: false, error: "key error: " + (e && e.message) });
  }

  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    const d = await r.json();
    const out = { success: d.success === true, hostname: d.hostname || null, challenge_ts: d.challenge_ts || null };
    if (!out.success) return res.status(200).json(out);

    const digest = crypto.createHash("sha256").update(evidence_json).digest("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiry = String(Math.floor(Date.now() / 1000) + EXPIRY_SECONDS);
    const msg = `veritas-v1|submit|${address.toLowerCase()}|${site_id}|${digest}|${expiry}|${nonce}`;
    out.nonce = nonce;
    out.expiry = expiry;
    out.signature = crypto.sign("sha256", Buffer.from(msg), { key, dsaEncoding: "ieee-p1363" }).toString("hex");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ success: false, error: "verify failed: " + (e && e.message) });
  }
}
