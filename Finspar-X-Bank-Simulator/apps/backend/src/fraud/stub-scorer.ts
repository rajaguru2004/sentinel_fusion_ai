import { Injectable } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import type { Scorer, UnifiedEvent, RiskVerdict } from './scorer.interface';

/**
 * Phase-1 stub per BANK_SIMULATOR_SPEC.md §9 — returns LOW for everything so all
 * flows run end to end. Phase 2 swaps this for HttpScorer -> FastAPI /score with
 * no call-site changes. Kept available; the demo wires HeuristicScorer instead.
 */
@Injectable()
export class StubScorer implements Scorer {
  async score(_event: UnifiedEvent): Promise<RiskVerdict> {
    return { riskScore: 0.05, riskLevel: RiskLevel.LOW, reasons: [] };
  }
}
