/**
 * schwab-client.js
 * 
 * Handles OAuth2 authentication, token management, and all Schwab Trader API calls.
 * Supports: accounts, positions, options chains, quotes, and order management.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = "https://api.schwabapi.com";
const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

export class SchwabClient {
  constructor({ appKey, appSecret, callbackUrl, tokenPath }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.callbackUrl = callbackUrl;
    this.tokenPath = tokenPath || path.join(__dirname, "..", "tokens.json");
    this.tokens = null;
    this._loadTokens();
  }

  // ─── Token Management ───────────────────────────────────────────────

  _loadTokens() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this.tokens = JSON.parse(fs.readFileSync(this.tokenPath, "utf-8"));
      }
    } catch (e) {
      console.error("Failed to load tokens:", e.message);
      this.tokens = null;
    }
  }

  _saveTokens(tokens) {
    this.tokens = {
      ...tokens,
      saved_at: Date.now(),
    };
    fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokens, null, 2));
  }

  isAuthenticated() {
    return this.tokens !== null && this.tokens.refresh_token;
  }

  _isAccessTokenExpired() {
    if (!this.tokens?.saved_at || !this.tokens?.expires_in) return true;
    const elapsed = (Date.now() - this.tokens.saved_at) / 1000;
    return elapsed >= this.tokens.expires_in - 60; // 60s buffer
  }

  getAuthUrl() {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.appKey,
      redirect_uri: this.callbackUrl,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(authCode) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: this.callbackUrl,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.appKey}:${this.appSecret}`).toString("base64")}`,
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${err}`);
    }

    const tokens = await resp.json();
    this._saveTokens(tokens);
    return tokens;
  }

  async _refreshAccessToken() {
    if (!this.tokens?.refresh_token) {
      throw new Error("No refresh token available. Run `npm run auth` to authenticate.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refresh_token,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.appKey}:${this.appSecret}`).toString("base64")}`,
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token refresh failed: ${resp.status} ${err}. Re-run \`npm run auth\`.`);
    }

    const tokens = await resp.json();
    this._saveTokens(tokens);
    return tokens;
  }

  async _getAccessToken() {
    if (this._isAccessTokenExpired()) {
      await this._refreshAccessToken();
    }
    return this.tokens.access_token;
  }

  // ─── HTTP Helpers ───────────────────────────────────────────────────

  async _get(endpoint, params = {}) {
    const token = await this._getAccessToken();
    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`GET ${endpoint} failed: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async _post(endpoint, body) {
    const token = await this._getAccessToken();
    const resp = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`POST ${endpoint} failed: ${resp.status} ${err}`);
    }

    // Schwab returns 201 with empty body for order placement
    if (resp.status === 201) {
      const location = resp.headers.get("location");
      return { success: true, orderId: location?.split("/").pop() };
    }

    return resp.json();
  }

  async _delete(endpoint) {
    const token = await this._getAccessToken();
    const resp = await fetch(`${BASE_URL}${endpoint}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`DELETE ${endpoint} failed: ${resp.status} ${err}`);
    }

    return { success: true };
  }

  // ─── Accounts & Positions ──────────────────────────────────────────

  async getAccountNumbers() {
    return this._get("/trader/v1/accounts/accountNumbers");
  }

  async getAccounts() {
    return this._get("/trader/v1/accounts", { fields: "positions" });
  }

  async getAccount(accountHash) {
    return this._get(`/trader/v1/accounts/${accountHash}`, { fields: "positions" });
  }

  // ─── Market Data ───────────────────────────────────────────────────

  async getQuote(symbol) {
    return this._get(`/marketdata/v1/${symbol}/quotes`);
  }

  async getQuotes(symbols) {
    return this._get("/marketdata/v1/quotes", {
      symbols: symbols.join(","),
    });
  }

  async getPriceHistory(symbol, { periodType, period, frequencyType, frequency } = {}) {
    return this._get(`/marketdata/v1/pricehistory`, {
      symbol,
      periodType: periodType || "month",
      period: period || 1,
      frequencyType: frequencyType || "daily",
      frequency: frequency || 1,
    });
  }

  // ─── Options Chain ─────────────────────────────────────────────────

  async getOptionChain(symbol, {
    contractType,    // CALL, PUT, ALL
    strikeCount,     // number of strikes above/below ATM
    range,           // ITM, NTM, OTM, ALL
    fromDate,        // yyyy-MM-dd
    toDate,          // yyyy-MM-dd
    expMonth,        // JAN, FEB, etc.
    optionType,      // S (standard), NS (non-standard), ALL
  } = {}) {
    return this._get("/marketdata/v1/chains", {
      symbol,
      contractType: contractType || "ALL",
      strikeCount: strikeCount || 10,
      range: range || "ALL",
      fromDate,
      toDate,
      expMonth,
      optionType: optionType || "S",
    });
  }

  // ─── Orders ────────────────────────────────────────────────────────

  async getOrders(accountHash, { maxResults, fromEnteredTime, toEnteredTime, status } = {}) {
    return this._get(`/trader/v1/accounts/${accountHash}/orders`, {
      maxResults: maxResults || 50,
      fromEnteredTime,
      toEnteredTime,
      status,
    });
  }

  async getOrder(accountHash, orderId) {
    return this._get(`/trader/v1/accounts/${accountHash}/orders/${orderId}`);
  }

  async placeOrder(accountHash, orderPayload) {
    return this._post(`/trader/v1/accounts/${accountHash}/orders`, orderPayload);
  }

  async cancelOrder(accountHash, orderId) {
    return this._delete(`/trader/v1/accounts/${accountHash}/orders/${orderId}`);
  }

  // ─── Order Builders ────────────────────────────────────────────────

  /**
   * Build a covered call order:
   * Sell-to-open a call option against existing long shares
   */
  static buildCoveredCallOrder(symbol, callSymbol, quantity, limitPrice) {
    return {
      orderType: "LIMIT",
      session: "NORMAL",
      duration: "DAY",
      price: limitPrice.toString(),
      orderStrategyType: "SINGLE",
      orderLegCollection: [
        {
          instruction: "SELL_TO_OPEN",
          quantity,
          instrument: {
            symbol: callSymbol,
            assetType: "OPTION",
          },
        },
      ],
    };
  }

  /**
   * Build a cash-secured put order (wheel strategy entry)
   */
  static buildCashSecuredPutOrder(putSymbol, quantity, limitPrice) {
    return {
      orderType: "LIMIT",
      session: "NORMAL",
      duration: "DAY",
      price: limitPrice.toString(),
      orderStrategyType: "SINGLE",
      orderLegCollection: [
        {
          instruction: "SELL_TO_OPEN",
          quantity,
          instrument: {
            symbol: putSymbol,
            assetType: "OPTION",
          },
        },
      ],
    };
  }

  /**
   * Build a simple equity market order
   */
  static buildEquityOrder(symbol, quantity, instruction = "BUY") {
    return {
      orderType: "MARKET",
      session: "NORMAL",
      duration: "DAY",
      orderStrategyType: "SINGLE",
      orderLegCollection: [
        {
          instruction, // BUY or SELL
          quantity,
          instrument: {
            symbol,
            assetType: "EQUITY",
          },
        },
      ],
    };
  }
}
