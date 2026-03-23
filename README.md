# schwab-mcp

MCP server that connects Claude to your Charles Schwab brokerage account via the Schwab Trader API. Built for wheel strategy management, options analysis, and portfolio monitoring.

## Tools Available

### Read (always safe)
| Tool | Description |
|------|-------------|
| `get_accounts` | Balances, buying power, positions summary |
| `get_positions` | Current holdings with P&L breakdown |
| `get_quote` | Real-time quotes for any symbols |
| `get_option_chain` | Options chain with greeks, OI, premiums |
| `get_orders` | Open/recent orders |
| `get_price_history` | Historical OHLCV candles |

### Write (dry_run=true by default)
| Tool | Description |
|------|-------------|
| `sell_covered_call` | Sell CC against shares you own |
| `sell_cash_secured_put` | Sell CSP (wheel entry) |
| `place_order` | Submit any custom order payload |
| `cancel_order` | Cancel an open order |

> **Safety**: All write tools default to `dry_run=true`, which shows the order preview without submitting. You must explicitly set `dry_run=false` to execute.

## Setup

### 1. Register a Schwab Developer App

1. Go to [developer.schwab.com](https://developer.schwab.com)
2. Create a **separate** developer account (not your brokerage login)
3. Click "Create App" in the Dashboard
4. Select **"Accounts and Trading Production"** as the API product
5. Set callback URL to `https://127.0.0.1:8182`
6. Wait for approval (status changes from "Approved — Pending" to "Ready For Use", typically 1-3 days)
7. Copy your **App Key** and **App Secret**

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your App Key and App Secret
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Authenticate

```bash
npm run auth
```

This opens your browser for Schwab OAuth login. You'll:
1. Log in with your **brokerage** credentials
2. Select which account(s) to authorize
3. Get redirected to a localhost URL
4. Paste that URL back into the terminal

Tokens are saved to `tokens.json`. The refresh token is valid for **7 days** — you'll need to re-auth after that.

### 5. Add to Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "schwab": {
      "command": "node",
      "args": ["/absolute/path/to/schwab-mcp/src/index.js"],
      "env": {}
    }
  }
}
```

Restart Claude Desktop. You should see the Schwab tools appear.

## Example Prompts

Once connected, you can ask Claude things like:

- "What are my current positions and P&L?"
- "Show me the AAPL options chain for calls expiring in the next 2 weeks"
- "What covered calls could I sell on my AAPL shares for ~30 delta?"
- "Preview a cash-secured put on SPY at the $540 strike"
- "What are my open orders?"
- "Cancel order 123456789"
- "Show me a 3-month price chart for TSLA"

## Architecture

```
Claude Desktop
    │ (stdio)
    ▼
schwab-mcp (this server)
    │ (HTTPS + OAuth2)
    ▼
Schwab Trader API
    │
    ▼
Your Brokerage Account
```

## Token Lifecycle

- **Access token**: Expires every 30 minutes, auto-refreshed by the client
- **Refresh token**: Valid for 7 days, then you must re-run `npm run auth`
- Consider a cron job to refresh tokens periodically to avoid expiration

## Notes

- The Schwab API may take 1-3 days to approve your app after registration
- Option symbols use OCC format: `AAPL  260417C00200000` (padded, strike × 1000)
- Rate limits apply — the client doesn't currently implement backoff (TODO)
- This is for personal use only per Schwab's Individual Trader API terms
