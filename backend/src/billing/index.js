// ─────────────────────────────────────────────────────────────────────────────
// Provider-agnostic billing connector
//
// One place that knows how to talk to the billing app. The rest of DSP calls
// billing.getSubscriptions(id) / getInvoices(id) / getQuotes(id) / getPayments(id)
// and always gets back the SAME canonical shape, no matter which billing vendor
// is configured. To support a new billing app later, add one entry to PROVIDERS
// and pick it in Admin → Settings — nothing else in DSP changes.
//
// Config is read from admin_settings (editable in the Settings UI, no redeploy):
//   billing_provider    'reselleros' (default) | 'generic-rest' | 'zoho'
//   billing_api_url      base URL, e.g. https://…run.app/api/v1
//   billing_api_key      the secret key issued by the billing app
//   billing_auth_style   'bearer' (default) | 'x-api-key'
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');
const https = require('https');
const http = require('http');

const enc = (v) => encodeURIComponent(String(v));

async function getSetting(key) {
  const [[row]] = await pool.query('SELECT value FROM admin_settings WHERE `key` = ?', [key]);
  return row?.value || '';
}

// Resolve the live config from settings. baseUrl has any trailing slash removed.
async function getConfig() {
  const [provider, baseUrl, apiKey, authStyle] = await Promise.all([
    getSetting('billing_provider'),
    getSetting('billing_api_url'),
    getSetting('billing_api_key'),
    getSetting('billing_auth_style'),
  ]);
  return {
    provider: (provider || 'reselleros').toLowerCase(),
    baseUrl: (baseUrl || '').replace(/\/+$/, ''),
    apiKey: apiKey || '',
    authStyle: (authStyle || 'bearer').toLowerCase(),
  };
}

function authHeaders(cfg) {
  if (!cfg.apiKey) return {};
  if (cfg.authStyle === 'x-api-key') return { 'X-API-Key': cfg.apiKey };
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

// Join base + relative path without producing a double slash. `path` is
// provider-relative (e.g. "customers/C-00001/invoices"); the base already
// carries any version prefix like /api/v1.
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

// Low-level JSON request. Resolves parsed JSON, or throws on network / non-2xx.
function requestJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = lib.request(options, (resp) => {
      let buf = '';
      resp.on('data', (c) => { buf += c; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(`Billing API ${resp.statusCode}: ${buf.slice(0, 200)}`));
        }
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`Invalid JSON from billing API: ${buf.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Billing API request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Pull the array out of a billing response that might be a bare array, or wrap
// its list under any of several common keys.
function pickList(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
    // Single-object responses (e.g. { support_subscription: {...} })
    for (const k of keys) {
      if (data[k] && typeof data[k] === 'object') return [data[k]];
    }
  }
  return [];
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

// ── Canonical mappers ────────────────────────────────────────────────────────
// Output uses field names the customer Billing.jsx already reads, so the UI
// renders any provider's data with no frontend change. Each mapper is defensive
// (multiple source field-name fallbacks) so minor provider differences are
// absorbed here and tuned in one place during live testing.
function mapSubscription(r = {}) {
  return {
    id:           first(r.id, r.subscription_id, r.sub_id),
    name:         first(r.product, r.product_name, r.name, r.plan, r.plan_name, 'Service'),
    plan:         first(r.plan, r.plan_name),
    seats:        first(r.seats, r.quantity),
    start_date:   first(r.start_date, r.commitment_start, r.created_at),
    renewal_date: first(r.renewal_date, r.next_renewal, r.next_billing_date, r.end_date, r.expiry, r.valid_until),
    status:       first(r.status, r.subscription_status, 'active'),
    amount:       first(r.amount, r.total),
    currency:     first(r.currency, 'INR'),
  };
}

function mapInvoice(r = {}) {
  return {
    id:             first(r.id, r.invoice_id),
    invoice_number: first(r.number, r.invoice_number, r.doc_number),
    invoice_date:   first(r.issue_date, r.invoice_date, r.date, r.created_at),
    due_date:       first(r.due_date),
    amount:         first(r.amount, r.total, r.final_price),
    currency:       first(r.currency, 'INR'),
    status:         first(r.status, 'paid'),
    pdf_url:        first(r.pdf_url, r.pdf),
  };
}

function mapQuote(r = {}) {
  return {
    id:           first(r.id, r.quote_id),
    quote_number: first(r.number, r.quote_number, r.doc_number),
    quote_date:   first(r.issue_date, r.quote_date, r.date, r.created_at),
    valid_until:  first(r.valid_until, r.expiry, r.expires_at),
    amount:       first(r.amount, r.total),
    currency:     first(r.currency, 'INR'),
    status:       first(r.status, 'pending'),
    pdf_url:      first(r.pdf_url, r.pdf),
    payment_url:  first(r.payment_url, r.pay_url),
  };
}

function mapPayment(r = {}) {
  return {
    id:         first(r.id, r.payment_id),
    amount:     first(r.amount, r.total),
    currency:   first(r.currency, 'INR'),
    reference:  first(r.reference, r.txn_id, r.transaction_id),
    method:     first(r.method, r.mode, r.payment_mode),
    paid_at:    first(r.paid_at, r.date, r.created_at),
    invoice_id: first(r.invoice_id, r.invoice),
  };
}

function mapCustomer(r = {}) {
  return {
    billing_customer_id: first(r.billing_customer_id, r.id, r.customer_id),
    name:                first(r.name, r.company, r.company_name),
    email:               first(r.email, r.billing_email),
    domain:              first(r.domain),
    status:              first(r.status, 'active'),
  };
}

// ── Provider registry ────────────────────────────────────────────────────────
// Each provider declares the relative paths for each resource and the response
// keys to unwrap. Mappers are shared (canonical is canonical); a provider can
// override a mapper if its raw shape is unusual.
const PROVIDERS = {
  // Custom billing app built by our dev — REST, base URL already ends in /api/v1
  reselleros: {
    paths: {
      customer:      (id) => `customers/${enc(id)}`,
      customerEmail: (email) => `customers?email=${enc(email)}`,
      customersList: (page, perPage) => `customers?page=${page}&per_page=${perPage}`,
      subscriptions: (id) => `customers/${enc(id)}/subscriptions`,
      invoices:      (id) => `customers/${enc(id)}/invoices`,
      quotes:        (id) => `customers/${enc(id)}/quotes`,
      payments:      (id) => `customers/${enc(id)}/payments`,
    },
    listKeys: {
      subscriptions: ['subscriptions', 'support_subscriptions', 'support_subscription', 'data'],
      invoices:      ['invoices', 'data'],
      quotes:        ['quotes', 'quotations', 'data'],
      payments:      ['payments', 'transactions', 'data'],
    },
  },

  // Spec-shaped default for "any billing app" that follows our integration spec.
  'generic-rest': {
    paths: {
      customer:      (id) => `customers/${enc(id)}`,
      customerEmail: (email) => `customers?email=${enc(email)}`,
      customersList: (page, perPage) => `customers?page=${page}&per_page=${perPage}`,
      subscriptions: (id) => `customers/${enc(id)}/subscriptions`,
      invoices:      (id) => `customers/${enc(id)}/invoices`,
      quotes:        (id) => `customers/${enc(id)}/quotes`,
      payments:      (id) => `customers/${enc(id)}/payments`,
    },
    listKeys: {
      subscriptions: ['subscriptions', 'data'],
      invoices:      ['invoices', 'data'],
      quotes:        ['quotes', 'data'],
      payments:      ['payments', 'data'],
    },
  },

  // Legacy query-style paths kept so the panel can be pointed back at the old
  // integration without a code change. Base URL for this provider is the host
  // root (paths carry their own /api prefix).
  zoho: {
    paths: {
      customer:      (id) => `api/customer?id=${enc(id)}`,
      customerEmail: (email) => `api/customers?email=${enc(email)}`,
      customersList: (page, perPage) => `api/customers?page=${page}&per_page=${perPage}`,
      subscriptions: (id) => `api/customer/subscriptions?id=${enc(id)}`,
      invoices:      (id) => `api/customer/invoices?id=${enc(id)}`,
      quotes:        (id) => `api/customer/quotations?id=${enc(id)}`,
      payments:      (id) => `api/customer/payments?id=${enc(id)}`,
    },
    listKeys: {
      subscriptions: ['subscriptions', 'data'],
      invoices:      ['invoices', 'data'],
      quotes:        ['quotations', 'quotes', 'data'],
      payments:      ['payments', 'data'],
    },
  },
};

function providerFor(cfg) {
  return PROVIDERS[cfg.provider] || PROVIDERS.reselleros;
}

// Fetch + unwrap + map a list resource. Returns [] when billing isn't
// configured or the customer has no billing id, so callers can render an
// empty state instead of erroring.
async function fetchList(resource, billingCustomerId, mapper) {
  const cfg = await getConfig();
  if (!cfg.baseUrl || !billingCustomerId) return [];
  const prov = providerFor(cfg);
  const url = joinUrl(cfg.baseUrl, prov.paths[resource](billingCustomerId));
  const raw = await requestJson('GET', url, authHeaders(cfg));
  const list = pickList(raw, prov.listKeys[resource]);
  return list.map(mapper);
}

// ── Public facade ────────────────────────────────────────────────────────────
module.exports = {
  async isConfigured() {
    const cfg = await getConfig();
    return !!cfg.baseUrl;
  },
  getConfig,

  getSubscriptions: (id) => fetchList('subscriptions', id, mapSubscription),
  getInvoices:      (id) => fetchList('invoices', id, mapInvoice),
  getQuotes:        (id) => fetchList('quotes', id, mapQuote),
  getPayments:      (id) => fetchList('payments', id, mapPayment),

  async getCustomer(billingCustomerId) {
    const cfg = await getConfig();
    if (!cfg.baseUrl || !billingCustomerId) return null;
    const prov = providerFor(cfg);
    const raw = await requestJson('GET', joinUrl(cfg.baseUrl, prov.paths.customer(billingCustomerId)), authHeaders(cfg));
    const body = raw?.customer || raw?.data || raw;
    return body ? mapCustomer(body) : null;
  },

  // List all customers, one page at a time. Throws an error tagged
  // `.listUnsupported = true` when the provider has no list-all endpoint (e.g.
  // ResellerOS today returns 400 "Provide ?email="). Callers use
  // isListUnsupportedError() to show a friendly "ask your dev" message.
  async listCustomers({ page = 1, perPage = 100 } = {}) {
    const cfg = await getConfig();
    if (!cfg.baseUrl) return { customers: [], page, pages: 1, total: 0 };
    const prov = providerFor(cfg);
    if (!prov.paths.customersList) {
      const err = new Error('list_unsupported'); err.listUnsupported = true; throw err;
    }
    const url = joinUrl(cfg.baseUrl, prov.paths.customersList(page, perPage));
    let raw;
    try {
      raw = await requestJson('GET', url, authHeaders(cfg));
    } catch (e) {
      // A 400/404 (or a "provide ?email" hint) means this provider can't list all.
      if (/\b40[04]\b/.test(e.message) || /provide\s+\?email/i.test(e.message)) {
        const err = new Error('list_unsupported'); err.listUnsupported = true; throw err;
      }
      throw e;
    }
    const list = pickList(raw, ['customers', 'data', 'results']);
    const pages = Number(raw?.pages || raw?.total_pages || raw?.last_page || 1) || 1;
    const total = Number(raw?.total ?? raw?.count ?? list.length) || list.length;
    return { customers: list.map(mapCustomer), page, pages, total };
  },

  isListUnsupportedError(e) { return !!(e && e.listUnsupported); },

  async findCustomerByEmail(email) {
    const cfg = await getConfig();
    if (!cfg.baseUrl || !email) return null;
    const prov = providerFor(cfg);
    const raw = await requestJson('GET', joinUrl(cfg.baseUrl, prov.paths.customerEmail(email)), authHeaders(cfg));
    const list = pickList(raw, ['customers', 'data']);
    const body = list[0] || raw?.customer || (Array.isArray(raw) ? null : raw);
    return body ? mapCustomer(body) : null;
  },

  // Build an authenticated GET for a document PDF. If the document already
  // carries an absolute pdf_url, use it; otherwise ask the provider for a path.
  // Returns { url, headers } for the controller's streaming proxy, or null.
  async pdfTarget(kind, doc) {
    const cfg = await getConfig();
    if (!cfg.baseUrl || !doc) return null;
    let url = doc.pdf_url || null;
    if (url && !/^https?:\/\//i.test(url)) url = joinUrl(cfg.baseUrl, url);
    if (!url) {
      const prov = providerFor(cfg);
      const base = kind === 'invoice' ? prov.paths.invoices : prov.paths.quotes;
      // Convention: <resource>/<id>/pdf
      url = `${joinUrl(cfg.baseUrl, base(doc.billing_customer_id || ''))}/${enc(doc.id)}/pdf`;
    }
    return { url, headers: authHeaders(cfg) };
  },

  // Probe the billing app with the given (or saved) config and report a
  // human-readable diagnosis. Used by the "Test connection" button so an admin
  // can confirm the URL + key work before saving. Overrides let the UI test the
  // values currently typed in the form (still unsaved).
  async testConnection({ url, key, provider, authStyle, customerId } = {}) {
    const saved = await getConfig();
    const cfg = {
      provider: (provider || saved.provider || 'reselleros').toLowerCase(),
      baseUrl: String(url != null && url !== '' ? url : saved.baseUrl).replace(/\/+$/, ''),
      apiKey: (key != null && key !== '' ? key : saved.apiKey),
      authStyle: (authStyle || saved.authStyle || 'bearer').toLowerCase(),
    };
    if (!cfg.baseUrl) return { ok: false, message: 'No base URL set. Enter the Billing API Base URL first.' };
    if (!cfg.apiKey)  return { ok: false, message: 'No API key set. Paste the key issued by your billing app.' };

    const prov = providerFor(cfg);
    const id = customerId || 'C-00001';
    const target = joinUrl(cfg.baseUrl, prov.paths.customer(id));

    // Raw request that resolves the status instead of throwing, so we can map
    // each HTTP code to a helpful message.
    let resp;
    try {
      resp = await new Promise((resolve, reject) => {
        const parsed = new URL(target);
        const lib = parsed.protocol === 'https:' ? https : http;
        const r = lib.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { Accept: 'application/json', ...authHeaders(cfg) },
        }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        r.on('error', reject);
        r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
        r.end();
      });
    } catch (e) {
      const msg = e.message === 'timeout'
        ? 'Timed out reaching the billing app. Check the base URL / network.'
        : `Could not reach the billing app (${e.code || e.message}). Check the base URL.`;
      return { ok: false, url: target, message: msg };
    }

    const s = resp.status;
    if (s >= 200 && s < 300) {
      let keys = [];
      try { keys = Object.keys(JSON.parse(resp.body) || {}); } catch {}
      return { ok: true, status: s, url: target,
        message: `Success — connected and fetched test customer ${id}.`,
        sampleKeys: keys.slice(0, 12) };
    }
    if (s === 401 || s === 403) return { ok: false, status: s, url: target, message: `Auth failed (${s}). The API key or auth header is wrong.` };
    if (s === 404) return { ok: false, status: s, url: target, message: `Reached the billing app and the key was accepted, but test customer "${id}" was not found (404). Connection is OK — try a real Billing ID.` };
    return { ok: false, status: s, url: target, message: `Billing app returned HTTP ${s}. ${String(resp.body || '').slice(0, 120)}` };
  },

  // Low-level escape hatches (used by legacy sync/push flows, unchanged).
  _getSetting: getSetting,
  _requestJson: requestJson,
  _joinUrl: joinUrl,
  _authHeaders: authHeaders,
};
