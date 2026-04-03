/**
 * auth.js
 * 
 * Run this once to complete the OAuth2 flow and save your tokens.
 * Usage: npm run auth
 * 
 * 1. Opens Schwab login in your browser
 * 2. You log in with your Schwab brokerage credentials
 * 3. Authorize the app and get redirected to localhost
 * 4. This script captures the auth code and exchanges it for tokens
 */

import { URL } from "url";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  const appKey = env.SCHWAB_APP_KEY;
  const appSecret = env.SCHWAB_APP_SECRET;
  const callbackUrl = env.SCHWAB_CALLBACK_URL || "https://127.0.0.1:8182";

  if (!appKey || appKey === "your_app_key_here") {
    console.error("❌ Set SCHWAB_APP_KEY in your .env file.");
    process.exit(1);
  }

  // Build authorization URL
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: appKey,
    redirect_uri: callbackUrl,
  });
  const authUrl = `https://api.schwabapi.com/v1/oauth/authorize?${authParams}`;

  console.log("\n🔐 Schwab OAuth2 Authentication\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log("2. Log in with your Schwab brokerage credentials.");
  console.log("3. Authorize the app.");
  console.log("4. You'll be redirected to a URL that looks like:");
  console.log(`   ${callbackUrl}?code=XXXXXX&session=YYYY\n`);
  console.log("5. Paste the FULL redirect URL below:\n");

  // Try to open browser automatically
  try {
    const open = (await import("open")).default;
    await open(authUrl);
    console.log("   (Browser opened automatically)\n");
  } catch {
    console.log("   (Could not open browser automatically — copy the URL above)\n");
  }

  // Read the redirect URL from stdin
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const redirectUrl = await new Promise((resolve) => {
    rl.question("Redirect URL: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  // Extract auth code from redirect URL
  let authCode;
  try {
    // Handle both full URL and just the code
    if (redirectUrl.startsWith("http")) {
      const url = new URL(redirectUrl);
      authCode = url.searchParams.get("code");
    } else {
      authCode = redirectUrl;
    }
  } catch {
    authCode = redirectUrl;
  }

  if (!authCode) {
    console.error("❌ Could not extract auth code from URL.");
    process.exit(1);
  }

  // URL decode the auth code (Schwab encodes it)
  authCode = decodeURIComponent(authCode);

  console.log("\n⏳ Exchanging auth code for tokens...\n");

  // Exchange code for tokens
  const tokenResp = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: callbackUrl,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error(`❌ Token exchange failed: ${tokenResp.status}`);
    console.error(err);
    process.exit(1);
  }

  const tokens = await tokenResp.json();
  tokens.saved_at = Date.now();

  const tokenPath = path.join(__dirname, "..", "tokens.json");
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });

  console.log("✅ Authentication successful! Tokens saved to tokens.json\n");
  console.log(`   Access token expires in: ${tokens.expires_in}s`);
  console.log(`   Refresh token valid for: ~7 days`);
  console.log(`\n   You can now start the MCP server: npm start\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
