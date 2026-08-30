#!/usr/bin/env node
/**
 * LinkedIn OAuth 2.0 Token Generator
 *
 * Usage:
 *   node get-linkedin-token.js <client_id> <client_secret>
 *
 * Opens a browser for LinkedIn login, captures the auth code,
 * exchanges it for an access token. Token lasts 2 months.
 */

const http = require("http");
const { execSync } = require("child_process");

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI  = "http://localhost:8424/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET env vars first.");
    process.exit(1);
}
const SCOPES        = "r_ads,rw_ads,r_ads_reporting,r_basicprofile,r_organization_social";

const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;

const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/callback")) return;

    const url = new URL(req.url, "http://localhost:8424");
    const code  = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h2>Error: ${error}</h2><p>${url.searchParams.get("error_description")}</p>`);
        console.error("OAuth error:", error, url.searchParams.get("error_description"));
        server.close();
        process.exit(1);
    }

    if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>No authorization code received</h2>");
        server.close();
        process.exit(1);
    }

    console.log("Authorization code received, exchanging for access token...");

    try {
        const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type:    "authorization_code",
                code:          code,
                redirect_uri:  REDIRECT_URI,
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }),
        });

        const data = await tokenRes.json();

        if (data.access_token) {
            const expiresIn = data.expires_in;
            const expiresDays = Math.round(expiresIn / 86400);
            console.log("\n=== LinkedIn Access Token ===");
            console.log(data.access_token);
            console.log(`\nExpires in: ${expiresDays} days (${expiresIn} seconds)`);
            console.log("\nAdd this to your claude_desktop_config.json env block as LINKEDIN_ACCESS_TOKEN");

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h2>Success!</h2><p>Access token printed to terminal. You can close this tab.</p>");
        } else {
            console.error("Token exchange failed:", data);
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
        }
    } catch (err) {
        console.error("Token exchange error:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h2>Error</h2><pre>${err.message}</pre>`);
    }

    server.close();
    setTimeout(() => process.exit(0), 1000);
});

server.listen(8424, () => {
    console.log("Listening on http://localhost:8424/callback");
    console.log("Opening LinkedIn authorization page...\n");
    try {
        execSync(`open "${authUrl}"`);
    } catch {
        console.log("Open this URL in your browser:\n" + authUrl);
    }
});
