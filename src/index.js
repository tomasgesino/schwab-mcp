/**
 * index.js — Schwab MCP Server
 * 
 * Exposes Schwab Trader API as MCP tools for Claude.
 * 
 * Tools:
 *   READ:
 *     - get_accounts        → account balances, buying power, positions
 *     - get_positions        → current holdings with P&L
 *     - get_quote            → real-time quote for a symbol
 *     - get_option_chain     → options chain with greeks
 *     - get_orders           → open/recent orders
 *     - get_price_history    → historical OHLCV data
 *   
 *   WRITE:
 *     - place_order          → submit any order (with confirmation gate)
 *     - sell_covered_call    → wheel strategy: sell CC against shares
 *     - sell_cash_secured_put → wheel strategy: sell CSP
 *     - cancel_order         → cancel an open order
 * 
 * Safety:
 *   All write operations include a dry_run parameter (default: true).
 *   When dry_run=true, returns the order payload without submitting.
 *   Set dry_run=false to actually place orders.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { SchwabClient } from "./schwab-client.js";
import { loadEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load Config ──────────────────────────────────────────────────────

const env = loadEnv();
const client = new SchwabClient({
  appKey: env.SCHWAB_APP_KEY,
  appSecret: env.SCHWAB_APP_SECRET,
  callbackUrl: env.SCHWAB_CALLBACK_URL,
  tokenPath: env.TOKEN_PATH || path.join(__dirname, "..", "tokens.json"),
});

// ── Helper: get first account hash ───────────────────────────────────

async function getDefaultAccountHash() {
  const accountNumbers = await client.getAccountNumbers();
  if (!accountNumbers?.length) throw new Error("No linked accounts found");
  return accountNumbers[0].hashValue;
}

// ── Helper: format response ──────────────────────────────────────────

function respond(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function respondError(message) {
  return {
    content: [{ type: "text", text: `❌ Error: ${message}` }],
    isError: true,
  };
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "schwab-trader",
  version: "1.0.0",
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  READ TOOLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "get_accounts",
  "Get all linked Schwab accounts with balances, buying power, and positions summary",
  {},
  async () => {
    try {
      const accounts = await client.getAccounts();
      return respond(accounts);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "get_positions",
  "Get current positions for an account with P&L, quantity, market value, and cost basis",
  {
    account_hash: z.string().optional().describe("Account hash (uses default if omitted)"),
  },
  async ({ account_hash }) => {
    try {
      const hash = account_hash || (await getDefaultAccountHash());
      const account = await client.getAccount(hash);
      const positions = account?.securitiesAccount?.positions || [];
      
      // Enrich with computed fields
      const enriched = positions.map((p) => {
        const netQuantity = p.longQuantity - p.shortQuantity;
        const absQuantity = Math.abs(netQuantity);
        return {
          symbol: p.instrument?.symbol,
          type: p.instrument?.assetType,
          quantity: netQuantity,
          marketValue: p.marketValue,
          averageCost: p.averagePrice,
          currentPrice: (p.currentDayProfitLoss != null && absQuantity > 0)
            ? p.averagePrice + p.currentDayProfitLoss / absQuantity
            : null,
          dayPL: p.currentDayProfitLoss,
          dayPLPercent: p.currentDayProfitLossPercentage,
          totalPL: absQuantity > 0
            ? (p.marketValue - p.averagePrice * absQuantity)
            : null,
        };
      });

      return respond(enriched);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "get_quote",
  "Get real-time quote for one or more symbols (stocks, ETFs, indices)",
  {
    symbols: z.string().describe("Comma-separated symbols, e.g. 'AAPL,MSFT,SPY'"),
  },
  async ({ symbols }) => {
    try {
      const syms = symbols.split(",").map((s) => s.trim().toUpperCase());
      const data = syms.length === 1
        ? await client.getQuote(syms[0])
        : await client.getQuotes(syms);
      return respond(data);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "get_option_chain",
  "Get options chain for a symbol with strikes, premiums, greeks, and open interest. Essential for wheel strategy analysis.",
  {
    symbol: z.string().describe("Underlying symbol, e.g. 'AAPL'"),
    contract_type: z.enum(["CALL", "PUT", "ALL"]).default("ALL").describe("Filter by calls, puts, or both"),
    strike_count: z.number().default(10).describe("Number of strikes above/below ATM"),
    range: z.enum(["ITM", "NTM", "OTM", "ALL"]).default("ALL").describe("Moneyness filter"),
    from_date: z.string().optional().describe("Start expiration date (yyyy-MM-dd)"),
    to_date: z.string().optional().describe("End expiration date (yyyy-MM-dd)"),
  },
  async ({ symbol, contract_type, strike_count, range, from_date, to_date }) => {
    try {
      const chain = await client.getOptionChain(symbol.toUpperCase(), {
        contractType: contract_type,
        strikeCount: strike_count,
        range,
        fromDate: from_date,
        toDate: to_date,
      });
      return respond(chain);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "get_orders",
  "Get open or recent orders for an account",
  {
    account_hash: z.string().optional().describe("Account hash (uses default if omitted)"),
    status: z.enum(["WORKING", "FILLED", "CANCELLED", "EXPIRED", "ALL"]).default("ALL"),
    max_results: z.number().default(20),
  },
  async ({ account_hash, status, max_results }) => {
    try {
      const hash = account_hash || (await getDefaultAccountHash());
      const params = { maxResults: max_results };
      if (status !== "ALL") params.status = status;
      const orders = await client.getOrders(hash, params);
      return respond(orders);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "get_price_history",
  "Get historical price data (OHLCV candles) for technical analysis",
  {
    symbol: z.string().describe("Symbol to get history for"),
    period_type: z.enum(["day", "month", "year", "ytd"]).default("month"),
    period: z.number().default(1),
    frequency_type: z.enum(["minute", "daily", "weekly", "monthly"]).default("daily"),
    frequency: z.number().default(1),
  },
  async ({ symbol, period_type, period, frequency_type, frequency }) => {
    try {
      const data = await client.getPriceHistory(symbol.toUpperCase(), {
        periodType: period_type,
        period,
        frequencyType: frequency_type,
        frequency,
      });
      return respond(data);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WRITE TOOLS (with dry_run safety gate)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "sell_covered_call",
  "Sell a covered call against existing long shares (wheel strategy). Returns order preview by default — set dry_run=false to execute.",
  {
    symbol: z.string().describe("Underlying symbol you own, e.g. 'AAPL'"),
    option_symbol: z.string().describe("Full OCC option symbol, e.g. 'AAPL  260417C00200000'"),
    contracts: z.number().describe("Number of contracts (1 contract = 100 shares)"),
    limit_price: z.number().describe("Limit price per contract (premium)"),
    dry_run: z.boolean().default(true).describe("Preview order without submitting (default: true)"),
    account_hash: z.string().optional(),
  },
  async ({ symbol, option_symbol, contracts, limit_price, dry_run, account_hash }) => {
    try {
      const order = SchwabClient.buildCoveredCallOrder(
        option_symbol,
        contracts,
        limit_price
      );

      if (dry_run) {
        return respond({
          mode: "DRY RUN — order NOT submitted",
          order_preview: order,
          message: "Set dry_run=false to execute this order.",
        });
      }

      const hash = account_hash || (await getDefaultAccountHash());
      const result = await client.placeOrder(hash, order);
      return respond({ mode: "LIVE", result });
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "sell_cash_secured_put",
  "Sell a cash-secured put (wheel strategy entry). Returns order preview by default — set dry_run=false to execute.",
  {
    option_symbol: z.string().describe("Full OCC option symbol for the put"),
    contracts: z.number().describe("Number of contracts"),
    limit_price: z.number().describe("Limit price per contract (premium)"),
    dry_run: z.boolean().default(true).describe("Preview order without submitting (default: true)"),
    account_hash: z.string().optional(),
  },
  async ({ option_symbol, contracts, limit_price, dry_run, account_hash }) => {
    try {
      const order = SchwabClient.buildCashSecuredPutOrder(
        option_symbol,
        contracts,
        limit_price
      );

      if (dry_run) {
        return respond({
          mode: "DRY RUN — order NOT submitted",
          order_preview: order,
          message: "Set dry_run=false to execute this order.",
        });
      }

      const hash = account_hash || (await getDefaultAccountHash());
      const result = await client.placeOrder(hash, order);
      return respond({ mode: "LIVE", result });
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "place_order",
  "Place a custom order (equity or option). Accepts a raw Schwab order JSON payload. Preview by default.",
  {
    order_payload: z.string().describe("JSON string of the Schwab order object"),
    dry_run: z.boolean().default(true).describe("Preview order without submitting (default: true)"),
    account_hash: z.string().optional(),
  },
  async ({ order_payload, dry_run, account_hash }) => {
    try {
      const order = JSON.parse(order_payload);

      // Basic validation of order structure
      if (!order.orderType) {
        return respondError("order_payload missing required field: orderType");
      }
      if (!Array.isArray(order.orderLegCollection) || order.orderLegCollection.length === 0) {
        return respondError("order_payload missing or empty orderLegCollection");
      }
      for (const leg of order.orderLegCollection) {
        if (!leg.instrument?.symbol) {
          return respondError("Each order leg must have an instrument with a symbol");
        }
        if (typeof leg.quantity !== "number" || leg.quantity <= 0 || leg.quantity > 10000) {
          return respondError(`Invalid quantity ${leg.quantity} — must be between 1 and 10,000`);
        }
      }

      if (dry_run) {
        return respond({
          mode: "DRY RUN — order NOT submitted",
          order_preview: order,
          message: "Set dry_run=false to execute this order.",
        });
      }

      const hash = account_hash || (await getDefaultAccountHash());
      const result = await client.placeOrder(hash, order);
      return respond({ mode: "LIVE", result });
    } catch (e) {
      return respondError(e.message);
    }
  }
);

server.tool(
  "cancel_order",
  "Cancel an open order by order ID. Preview by default — set dry_run=false to execute.",
  {
    order_id: z.string().describe("The order ID to cancel"),
    dry_run: z.boolean().default(true).describe("Preview cancellation without executing (default: true)"),
    account_hash: z.string().optional(),
  },
  async ({ order_id, dry_run, account_hash }) => {
    try {
      if (dry_run) {
        return respond({
          mode: "DRY RUN — order NOT cancelled",
          order_id,
          message: "Set dry_run=false to actually cancel this order.",
        });
      }

      const hash = account_hash || (await getDefaultAccountHash());
      const result = await client.cancelOrder(hash, order_id);
      return respond(result);
    } catch (e) {
      return respondError(e.message);
    }
  }
);

// ── Start Server ─────────────────────────────────────────────────────

async function main() {
  if (!client.isAuthenticated()) {
    console.error("⚠️  Not authenticated. Run `npm run auth` first to complete OAuth flow.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🟢 Schwab MCP server running (stdio transport)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
