export function distribution(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, p50: null, p95: null, max: null };
  const percentile = (p) =>
    Math.round(
      xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)] * 100,
    ) / 100;
  return {
    n: xs.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: percentile(1),
  };
}
export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.browser = [];
  }
  recordBrowser(sample) {
    if (
      !sample ||
      !["draftkings", "fanduel"].includes(sample.book) ||
      !["live", "pregame"].includes(sample.phase)
    )
      return false;
    for (const key of [
      "backendToPaintMs",
      "feedCreatedToPaintMs",
      "clockUncertaintyMs",
    ]) {
      if (
        sample[key] != null &&
        (!Number.isFinite(sample[key]) || Math.abs(sample[key]) > 120000)
      )
        return false;
    }
    this.browser.push({
      at: Date.now(),
      book: sample.book,
      phase: sample.phase,
      backendToPaintMs: sample.backendToPaintMs,
      feedCreatedToPaintMs: sample.feedCreatedToPaintMs,
      clockUncertaintyMs: sample.clockUncertaintyMs,
    });
    if (this.browser.length > 5000) this.browser.shift();
    return true;
  }
  report(history, sources) {
    const result = {
      startedAt: this.startedAt,
      generatedAt: Date.now(),
      sources,
      notes: [
        "Browser samples are client-reported estimates after two animation frames, corrected using /api/time. Inspect clock uncertainty.",
        "DraftKings createdTime is the provider feed timestamp, not a verified trading-engine change timestamp. Cross-host clock skew can affect it.",
        "FanDuel has no source-change timestamp in the observed price response. Full source-to-screen latency is unknown.",
        "With 2 second polling, expected waiting time is about 1 second and nominal maximum about 2 seconds before request time, absent failures. This is an estimate, not a measured guarantee.",
        "Live rows with n=0 mean not measured; pregame results must not be presented as live results.",
      ],
      measurements: {},
    };
    for (const book of ["draftkings", "fanduel"]) {
      result.measurements[book] = {};
      for (const phase of ["pregame", "live"]) {
        const h = history.filter(
          (x) => x.book === book && x.phases.includes(phase),
        );
        const b = this.browser.filter(
          (x) => x.book === book && x.phase === phase,
        );
        result.measurements[book][phase] = {
          acquisitionRequestMs: distribution(h.map((x) => x.requestMs)),
          processingMs: distribution(h.map((x) => x.processingMs)),
          feedCreatedToBackendMs: distribution(
            h
              .filter((x) => x.sourceCreatedAt)
              .map((x) => x.receivedAt - x.sourceCreatedAt),
          ),
          backendToPaintMs: distribution(b.map((x) => x.backendToPaintMs)),
          feedCreatedToPaintMs: distribution(
            b.map((x) => x.feedCreatedToPaintMs),
          ),
          clockUncertaintyMs: distribution(b.map((x) => x.clockUncertaintyMs)),
          decodedPayloadBytes: distribution(h.map((x) => x.decodedBytes)),
        };
      }
    }
    return result;
  }
}
