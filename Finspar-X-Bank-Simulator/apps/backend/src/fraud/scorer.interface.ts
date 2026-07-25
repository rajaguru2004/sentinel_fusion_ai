import { RiskLevel } from '@prisma/client';

/**
 * The schema `sentinel_fusion_ai` expects. Built by UnifiedEventBuilder and
 * passed to a Scorer. `country` is a weak feature here (India-only) — device,
 * IP, velocity and beneficiary-age signals carry the load (§9).
 */
export interface UnifiedEvent {
  /**
   * Stable, logical id for this event — reused across retries so the model's
   * feature store advances velocity counters exactly once (idempotency key for
   * /score and /ingest). Namespaced per logical event, e.g. `pay:{paymentId}`,
   * `mod:{paymentId}`, `login:{loginEventId}`, `ben-add:{beneficiaryId}`.
   */
  eventId?: string;
  eventType:
    | 'LOGIN'
    | 'BENEFICIARY_ADD'
    | 'BENEFICIARY_ACTIVATE'
    | 'BALANCE_VIEW'
    | 'STATEMENT_VIEW'
    | 'PAYMENT_INITIATE'
    | 'PAYMENT_MODIFY'
    | 'VELOCITY';
  userId?: string;
  paymentId?: string;
  ip?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  sessionId?: string;
  timestamp: string;
  amount?: number; // rupees
  rail?: string;
  beneficiaryAgeMinutes?: number;
  isNewBeneficiary?: boolean;
  txnCountLastHour?: number;
  amountVsUserMean?: number; // ratio
  nameMismatch?: boolean;

  // Step 8 enrichment — richer signals the v2 model trains on. All rupees / years
  // / seconds; omitted when unknown (adapter drops undefined for extra="forbid").
  balanceBefore?: number; // payer account, rupees
  balanceAfter?: number; // payer account after debit, rupees
  counterpartyBalanceBefore?: number; // own-bank beneficiary only
  counterpartyBalanceAfter?: number;
  customerAge?: number; // years
  accountAgeSeconds?: number;
  income?: number; // normalized 0..1 band
  emailIsFree?: boolean;
  channel?: string; // web | mobile | atm | pos | branch | api
  deviceOs?: string;
  country?: string; // ISO alpha-2, resolved from the client IP (geo-IP)
  geoLat?: number;
  geoLon?: number;
}

export interface RiskVerdict {
  riskScore: number; // 0..1
  riskLevel: RiskLevel;
  reasons: string[];
  modelScores?: Record<string, number>;
}

export const SCORER = Symbol('SCORER');

export interface Scorer {
  score(event: UnifiedEvent): Promise<RiskVerdict>;
}
