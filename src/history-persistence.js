import { randomUUID } from "node:crypto";
import { Client } from "pg";

const CREATE = `CREATE TABLE IF NOT EXISTS fieldline_price_history (
  series_key text PRIMARY KEY, payload jsonb NOT NULL, generation text NOT NULL,
  newest_price_at bigint NOT NULL DEFAULT 0, newest_observation_at bigint NOT NULL DEFAULT 0,
  checkpoint_at bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
const MIGRATE = `ALTER TABLE fieldline_price_history
  ADD COLUMN IF NOT EXISTS newest_price_at bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS newest_observation_at bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkpoint_at bigint NOT NULL DEFAULT 0`;
const UPSERT = `INSERT INTO fieldline_price_history
  (series_key, payload, generation, newest_price_at, newest_observation_at, checkpoint_at, updated_at)
  VALUES ($1, $2::jsonb, $3, $4, $5, $6, now()) ON CONFLICT (series_key) DO UPDATE
  SET payload = EXCLUDED.payload, generation = EXCLUDED.generation,
  newest_price_at = EXCLUDED.newest_price_at, newest_observation_at = EXCLUDED.newest_observation_at,
  checkpoint_at = EXCLUDED.checkpoint_at, updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.newest_price_at > fieldline_price_history.newest_price_at
     OR (EXCLUDED.newest_price_at = fieldline_price_history.newest_price_at
         AND EXCLUDED.checkpoint_at > fieldline_price_history.checkpoint_at)`;
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const safeConfig = connectionString => {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new TypeError("Invalid history database configuration");
  // Do not let a connection-string option weaken explicit TLS verification or
  // trigger reading local certificate files. Render uses a public trusted CA.
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat", "sslnegotiation"])
    url.searchParams.delete(key);
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 };
};

/** Optional durable history. A single connection performs background work.
 * Each database row is one bounded series: no giant JSON parse/stringify stalls,
 * and no database operation or restored state determines live price eligibility.
 * A dedicated database/table is required. Overlapping deployments can only
 * replace a row with a newer actual price observation; shutdown gap timestamps
 * cannot overwrite a newer process's baseline. There is no whole-table reset.
 * A crash can lose the latest 60 seconds, or longer during storage outages. */
export class HistoryPersistence {
  constructor({ history, connectionString = "", now = Date.now, saveIntervalMs = 60000,
    clientFactory = config => new Client(config), yieldControl = yieldTurn } = {}) {
    if (!history?.serializeRows || !history?.load) throw new TypeError("History persistence requires a PriceHistory instance");
    if (!Number.isInteger(saveIntervalMs) || saveIntervalMs < 60000) throw new RangeError("History save interval must be at least 60 seconds");
    Object.assign(this, { history, connectionString, now, saveIntervalMs, clientFactory, yieldControl });
    this.enabled = typeof connectionString === "string" && connectionString.length > 0;
    this.state = this.enabled ? "idle" : "disabled"; this.started = false; this.closed = false; this.closing = false;
    this.client = null; this.flight = null; this.timer = null; this.startJob = null; this.restored = false;
    this.lastAttemptAt = null; this.lastSavedAt = null; this.lastRestoredAt = null; this.lastFailureAt = null;
    this.savedSeries = 0; this.restoredSeries = 0; this.rejectedRows = 0;
  }

  start() {
    if (this.started || this.closed) return this;
    this.started = true;
    if (!this.enabled) return this;
    // Start returns before any connection, restore or checkpoint work occurs.
    this.startJob = setImmediate(() => { this.startJob = null; void this.save(); });
    this.timer = setInterval(() => { void this.save(); }, this.saveIntervalMs);
    this.timer.unref?.();
    return this;
  }

  status() {
    return { enabled: this.enabled, state: this.state, available: ["ready", "saving"].includes(this.state), pending: Boolean(this.flight),
      saveIntervalMs: this.saveIntervalMs, lastAttemptAt: this.lastAttemptAt, lastSavedAt: this.lastSavedAt,
      lastRestoredAt: this.lastRestoredAt, lastFailureAt: this.lastFailureAt, savedSeries: this.savedSeries,
      restoredSeries: this.restoredSeries, rejectedRows: this.rejectedRows,
      message: this.state === "unavailable" ? "Persistent history unavailable; current observations remain in memory."
        : this.state === "disabled" ? "Persistent history is not configured; observations are kept in memory."
          : "Historical observations only; restored data never makes a live price eligible." };
  }

  save() {
    if (!this.enabled || this.closed || this.closing) return Promise.resolve(this.status());
    if (this.flight) return this.flight;
    this.flight = this.cycle().catch(async () => {
      if (!this.closed) this.state = "unavailable";
      this.lastFailureAt = this.now();
      await this.disconnect();
    }).finally(() => { this.flight = null; });
    return this.flight.then(() => this.status());
  }

  async connect() {
    if (this.client) return this.client;
    this.state = "connecting";
    const client = this.clientFactory(safeConfig(this.connectionString));
    this.client = client;
    client.on("error", () => {
      if (this.client !== client || this.closed) return;
      this.state = "unavailable"; this.lastFailureAt = this.now();
      void this.disconnect();
    });
    await client.connect();
    if (this.closed || this.client !== client) throw new Error("History persistence closed");
    await client.query(CREATE);
    await client.query(MIGRATE);
    return client;
  }

  async restore(client) {
    if (this.closed) return;
    this.state = "restoring";
    const maxRows = Number.isInteger(this.history.maxSeries) ? Math.max(1, Math.min(4096, this.history.maxSeries)) : 1024;
    await client.query("BEGIN");
    // The text cast avoids pg's eager JSON parsing of the whole result. A cursor
    // bounds the network/result buffer, and each series yields before parsing.
    // Select the newest bounded set, then restore it in observation order so
    // older rows never gain priority merely because they arrived later.
    await client.query(`DECLARE fieldline_history_cursor NO SCROLL CURSOR FOR
      SELECT payload::text AS payload FROM (
        SELECT series_key, payload, newest_observation_at FROM fieldline_price_history
        ORDER BY newest_observation_at DESC, series_key LIMIT ${maxRows}
      ) AS retained ORDER BY newest_observation_at ASC, series_key`);
    let processed = 0;
    while (!this.closed && processed < maxRows) {
      const result = await client.query("FETCH FORWARD 8 FROM fieldline_history_cursor");
      if (!result.rows.length) break;
      for (const row of result.rows) {
        if (this.closed || processed++ >= maxRows) break;
        await this.yieldControl();
        try {
          if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > 2 * 1024 * 1024)
            throw new TypeError("Invalid stored history row");
          const checkpoint = JSON.parse(row.payload);
          if (!Array.isArray(checkpoint?.series) || checkpoint.series.length !== 1)
            throw new TypeError("Invalid stored history row");
          const loaded = this.history.load(checkpoint);
          this.restoredSeries += loaded.loadedSeries;
          if (loaded.rejectedPoints) this.rejectedRows++;
        } catch { this.rejectedRows++; }
      }
    }
    await client.query("CLOSE fieldline_history_cursor");
    await client.query("COMMIT");
    this.restored = true; this.lastRestoredAt = this.now();
  }

  async cycle() {
    this.lastAttemptAt = this.now();
    const client = await this.connect();
    if (this.closed) return;
    if (!this.restored) await this.restore(client);
    if (this.closed) return;
    this.state = "saving";
    const generation = randomUUID(); let count = 0;
    await client.query("BEGIN");
    for await (const { key, checkpoint } of this.history.serializeRows({ yieldControl: this.yieldControl })) {
      if (this.closed) throw new Error("History persistence closed");
      // serializeRows already yielded; this stringify is bounded to one series.
      const payload = JSON.stringify(checkpoint);
      if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw new RangeError("History series exceeds storage bound");
      const points = checkpoint.series[0].points;
      const newestPriceAt = points.findLast(p => !p.gap && !p.missing && !p.suspended)?.at ?? 0;
      await client.query(UPSERT, [key, payload, generation, newestPriceAt, points.at(-1).at, checkpoint.savedAt]); count++;
    }
    // Prune only observations outside retention; another process's newer rows
    // are never deleted merely because this process did not include them.
    await client.query("DELETE FROM fieldline_price_history WHERE newest_observation_at < $1 AND newest_observation_at > 0",
      [this.now() - this.history.retentionMs]);
    await client.query("COMMIT");
    this.savedSeries = count; this.lastSavedAt = this.now();
    if (!this.closed) this.state = "ready";
  }

  async disconnect() {
    const client = this.client; this.client = null;
    if (client) { try { await client.end(); } catch { /* no credential-bearing driver errors */ } }
  }

  async close({ save = true, timeoutMs = 5000 } = {}) {
    if (this.closed) return this.status();
    clearInterval(this.timer); clearImmediate(this.startJob); this.timer = this.startJob = null;
    const pending = this.flight ?? (save ? this.save() : null);
    this.closing = true;
    let timeout;
    // Shutdown cannot wait indefinitely for an optional persistence dependency.
    await Promise.race([pending ?? Promise.resolve(), new Promise(resolve => { timeout = setTimeout(resolve, Math.min(5000, Math.max(1, timeoutMs))); })]);
    clearTimeout(timeout); this.closed = true;
    await Promise.race([this.disconnect(), new Promise(resolve => { timeout = setTimeout(resolve, 1000); })]);
    clearTimeout(timeout); this.state = "closed";
    return this.status();
  }
}
