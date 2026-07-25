import { Injectable } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import type { Scorer, UnifiedEvent, RiskVerdict } from './scorer.interface';

/**
 * Demo stand-in scorer for Phase 1. NOT the ML model — it applies transparent
 * heuristics over the same UnifiedEvent the real engine will consume, so the
 * risk meter, holds, blocks and analyst feed are demonstrable before phase 2.
 * Implements the identical Scorer interface; swapping to HttpScorer is a one-line
 * provider change. Bands per §9: <.25 LOW, <.50 MEDIUM, <.75 HIGH, >=.75 CRITICAL.
 */
@Injectable()
export class HeuristicScorer implements Scorer {
  async score(event: UnifiedEvent): Promise<RiskVerdict> {
    let score = 0.05;
    const reasons: string[] = [];
    const modelScores: Record<string, number> = {};

    const add = (delta: number, key: string, reason: string): void => {
      score += delta;
      modelScores[key] = delta;
      reasons.push(reason);
    };

    // Velocity — scripted / rapid-fire bursts.
    if ((event.txnCountLastHour ?? 0) > 20) {
      add(0.7, 'velocity', `${event.txnCountLastHour} transactions in the last hour (velocity spike)`);
    } else if ((event.txnCountLastHour ?? 0) > 8) {
      add(0.2, 'velocity', `Elevated transaction velocity (${event.txnCountLastHour}/hr)`);
    }

    // Beneficiary cooling period — recently activated payee.
    if (event.beneficiaryAgeMinutes != null && event.beneficiaryAgeMinutes < 30) {
      const big = (event.amount ?? 0) > 50000;
      add(big ? 0.45 : 0.2, 'beneficiary_age', `Beneficiary activated ${Math.round(event.beneficiaryAgeMinutes)} min ago${big ? ' with a high-value transfer' : ''}`);
    }

    // Amount vs the user's mean.
    if ((event.amountVsUserMean ?? 1) >= 3) {
      add(0.25, 'amount_vs_mean', `Amount ${event.amountVsUserMean?.toFixed(1)}× the account average`);
    }

    // Absolute high value.
    if ((event.amount ?? 0) >= 1_000_000) {
      add(0.15, 'high_value', `High-value transfer (₹${Math.round((event.amount ?? 0)).toLocaleString('en-IN')})`);
    }

    // Name mismatch on the beneficiary.
    if (event.nameMismatch) {
      add(0.4, 'name_mismatch', 'Entered name differs from bank-fetched account holder name');
    }

    // New device on login — account-takeover signal.
    if (event.eventType === 'LOGIN' && event.deviceFingerprint === 'NEW') {
      add(0.5, 'new_device', 'Login from an unrecognised device fingerprint');
    }

    score = Math.min(0.99, Math.max(0, score));
    if (reasons.length === 0) reasons.push('No anomalies detected');

    return { riskScore: Number(score.toFixed(2)), riskLevel: bandOf(score), reasons, modelScores };
  }
}

export function bandOf(score: number): RiskLevel {
  if (score < 0.25) return RiskLevel.LOW;
  if (score < 0.5) return RiskLevel.MEDIUM;
  if (score < 0.75) return RiskLevel.HIGH;
  return RiskLevel.CRITICAL;
}
