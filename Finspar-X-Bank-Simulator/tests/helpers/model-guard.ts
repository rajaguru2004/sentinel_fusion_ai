/**
 * Guards against the silent fail-open.
 *
 * `HttpScorer.score()` catches EVERY error — timeout, connection refused,
 * `scored:false` — and returns `HeuristicScorer` output instead
 * (apps/backend/src/fraud/http-scorer.ts). From outside, a HELD payment produced
 * by the heuristic's beneficiary-age rule is indistinguishable from one produced
 * by XGBoost: same status, same riskLevel HIGH, same shape. Both make the demo
 * look like it worked.
 *
 * `modelScores` is persisted on FraudEvent but NOT exposed by
 * /api/analyst/feed, so the detection has to be behavioural.
 */

/**
 * Verbatim from apps/backend/src/fraud/heuristic-scorer.ts. These strings share
 * no wording with sentinel_fusion_ai/service/reasons.py, so a match means the
 * heuristic answered. Keep in sync if that file changes.
 */
export const HEURISTIC_SIGNATURES: RegExp[] = [
  /^No anomalies detected$/,
  /transactions in the last hour \(velocity spike\)$/,
  /^Elevated transaction velocity \(\d+\/hr\)$/,
  /^Beneficiary activated \d+ min ago/,
  /^Amount [\d.]+× the account average$/,
  /^High-value transfer \(₹/,
  /^Entered name differs from bank-fetched account holder name$/,
  /^Login from an unrecognised device fingerprint$/,
];

export interface VerdictLike {
  riskScore: number;
  riskLevel?: string;
  reasons: string[];
}

export function assertModelVerdict(v: VerdictLike, context = ''): void {
  const hit = v.reasons?.find((r) => HEURISTIC_SIGNATURES.some((p) => p.test(r)));
  if (hit) {
    throw new Error(
      `FAIL-OPEN DETECTED${context ? ` [${context}]` : ''}\n` +
        `  This verdict came from HeuristicScorer, NOT the Sentinel model.\n` +
        `  Offending reason : ${JSON.stringify(hit)}\n` +
        `  All reasons      : ${JSON.stringify(v.reasons)}\n` +
        `  riskScore        : ${v.riskScore}\n\n` +
        `  HttpScorer catches every error and silently returns heuristic output. Causes:\n` +
        `    - SENTINEL_ENABLED is false (the default)\n` +
        `    - SENTINEL_URL is "localhost" (-> IPv6) or host.docker.internal on a host process\n` +
        `    - SENTINEL_TIMEOUT_MS (default 800) is below the cold SHAP call (~6s)\n` +
        `  Confirm with: grep "failing open to heuristic" .artifacts/backend.log`,
    );
  }
}

/**
 * A positive proof, where it applies: HeuristicScorer derives the level from the
 * score via bandOf() (<0.25 LOW, <0.50 MEDIUM, <0.75 HIGH), so it can never
 * report HIGH with a score below 0.25. The model's per-model FITTED bands do
 * exactly that — fraud_payment's high band starts at 0.0396. So this combination
 * can only have come from the model.
 */
export function scoredByModelBands(v: VerdictLike): boolean {
  return v.riskLevel === 'HIGH' && v.riskScore < 0.25;
}
