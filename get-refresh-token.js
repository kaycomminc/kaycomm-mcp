const http = require("http");
const { exec } = require("child_process");
const querystring = require("querystring");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const PORT = 3847;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  querystring.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>No code received.</h2>");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: querystring.stringify({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json();

    if (data.refresh_token) {
      console.log("\n=== SUCCESS ===");
      console.log("Refresh token:", data.refresh_token);
      console.log("\nAdd this as GOOGLE_REFRESH_TOKEN_2 in your environment.\n");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Success! Refresh token printed in terminal.</h2><p>You can close this tab.</p>");
    } else {
      console.error("No refresh_token in response:", data);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>Error</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Error</h2><pre>${err.message}</pre>`);
  }

  server.close();
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log("Opening browser for authorization...\n");
  exec(`open "${authUrl}"`);
});
