export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method" });
  const token = req.body && req.body.token;
  if (!token) return res.status(400).json({ success: false, error: "no token" });
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return res.status(500).json({ success: false, error: "server not configured" });
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    const d = await r.json();
    return res.status(200).json({ success: d.success === true, hostname: d.hostname || null, challenge_ts: d.challenge_ts || null });
  } catch (e) {
    return res.status(502).json({ success: false, error: "verify failed: " + (e && e.message) });
  }
}
