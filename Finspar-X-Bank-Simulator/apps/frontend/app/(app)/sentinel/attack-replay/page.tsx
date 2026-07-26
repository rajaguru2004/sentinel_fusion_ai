'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Shield,
  AlertTriangle,
  Play,
  RotateCcw,
  ChevronRight,
  Zap,
  Eye,
  Lock,
  Database,
  Wifi,
  Server,
  Activity,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Info,
  Loader2,
  Terminal,
  Radio,
} from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';

// ─── Types ─────────────────────────────────────────────────────────────────
interface AttackStageInfo {
  stage_id: string;
  stage_name: string;
  kill_chain_phase: string;
  mitre_tactic_id: string;
  description: string;
}

interface EvidenceSignal {
  feature: string;
  value: unknown;
  shap_attribution: number;
  description: string;
  stage_hints: string[];
}

interface ReplayStep {
  step_index: number;
  stage_id: string;
  stage_name: string;
  timestamp: string;
  title: string;
  description: string;
  evidence: EvidenceSignal[];
  is_sentinel_intervention: boolean;
}

interface PredictedStage {
  stage_id: string;
  stage_name: string;
  kill_chain_phase: string;
  confidence: number;
  probability_label: string;
  explanation: string;
  supporting_evidence: string[];
  recommended_actions: string[];
}

interface SentinelResponseStep {
  step_index: number;
  action: string;
  outcome: string;
  stage_blocked: string;
}

interface ScoreOut {
  event_id: string;
  risk_score: number;
  risk_level: string;
  model: string;
  model_version: string;
  scored: boolean;
}

interface AttackReplayResponse {
  incident_id: string;
  event_id: string;
  domain: string;
  risk_score: number;
  risk_level: string;
  model_version: string;
  investigated_at: string;
  score: ScoreOut;
  current_stage: AttackStageInfo;
  attack_maturity: string;
  completed_stages: AttackStageInfo[];
  replay_timeline: ReplayStep[];
  observed_evidence: EvidenceSignal[];
  predicted_stages: PredictedStage[];
  sentinel_response: SentinelResponseStep[];
  ai_summary: string;
  investigation_confidence: number;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────
interface Scenario {
  id: string;
  label: string;
  icon: typeof Shield;
  color: string;
  description: string;
  payload: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'lateral-smb',
    label: 'SMB Lateral Movement',
    icon: Server,
    color: '#ea580c',
    description: 'Attacker pivots via SMB (port 445) after initial compromise. Classic Windows domain attack.',
    payload: {
      event_id: 'demo-lateral-001',
      event_domain: 'cyber',
      event_time: new Date().toISOString(),
      user_id: 'threat-actor-42',
      device_id: 'SRV-PROD-DC01',
      bytes_out: 85_000,
      bytes_in: 12_000,
      dst_port: 445,
      protocol: 'TCP',
      severity: 4,
      duration_s: 3600,
    },
  },
  {
    id: 'data-exfil',
    label: 'Data Exfiltration',
    icon: Database,
    color: '#dc2626',
    description: 'Massive outbound transfer detected. Attacker exfiltrating sensitive data over HTTPS.',
    payload: {
      event_id: 'demo-exfil-001',
      event_domain: 'cyber',
      event_time: new Date().toISOString(),
      user_id: 'insider-threat-7',
      device_id: 'WKS-FIN-TEAM-03',
      bytes_out: 280_000,
      bytes_in: 2_000,
      dst_port: 443,
      protocol: 'TCP',
      severity: 5,
      duration_s: 7200,
    },
  },
  {
    id: 'c2-beacon',
    label: 'C2 Beaconing',
    icon: Radio,
    color: '#7c3aed',
    description: 'DNS tunnelling detected — attacker maintaining covert command & control channel.',
    payload: {
      event_id: 'demo-c2-001',
      event_domain: 'cyber',
      event_time: new Date().toISOString(),
      user_id: 'unknown-actor',
      device_id: 'SRV-APP-TIER-02',
      bytes_out: 15_000,
      bytes_in: 8_000,
      dst_port: 53,
      protocol: 'DNS',
      severity: 3,
      duration_s: 14_400,
    },
  },
  {
    id: 'rdp-pivot',
    label: 'RDP Pivot Attack',
    icon: Terminal,
    color: '#d97706',
    description: 'Remote Desktop Protocol used for lateral movement toward high-value target servers.',
    payload: {
      event_id: 'demo-rdp-001',
      event_domain: 'cyber',
      event_time: new Date().toISOString(),
      user_id: 'compromised-admin',
      device_id: 'SRV-BACKUP-01',
      bytes_out: 45_000,
      bytes_in: 35_000,
      dst_port: 3389,
      protocol: 'TCP',
      severity: 4,
      is_foreign_request: 1,
      duration_s: 1800,
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
const RISK_COLORS: Record<string, string> = {
  low: '#059669',
  medium: '#d97706',
  high: '#ea580c',
  critical: '#dc2626',
};

const STAGE_ICONS: Record<string, typeof Shield> = {
  initial_access: Eye,
  execution: Terminal,
  persistence: Lock,
  privilege_escalation: TrendingUp,
  defense_evasion: Shield,
  credential_access: Lock,
  discovery: Activity,
  lateral_movement: Wifi,
  collection: Database,
  command_and_control: Radio,
  exfiltration: TrendingUp,
  impact: AlertTriangle,
  sentinel_intervention: Shield,
};

function riskColor(level: string) {
  return RISK_COLORS[level?.toLowerCase()] ?? '#64748b';
}

function confidenceBar(value: number) {
  const color =
    value >= 0.65 ? '#dc2626' : value >= 0.4 ? '#ea580c' : '#d97706';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${value * 100}%`, background: color }}
        />
      </div>
      <span className="w-10 text-right text-xs font-mono text-text-muted">
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}

function RiskPill({ level }: { level: string }) {
  const color = riskColor(level);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
      style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
    >
      {level}
    </span>
  );
}

function MaturityPill({ maturity }: { maturity: string }) {
  const map: Record<string, string> = {
    Early: '#059669',
    Mid: '#d97706',
    Late: '#ea580c',
    Critical: '#dc2626',
  };
  const color = map[maturity] ?? '#64748b';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
    >
      <Activity className="h-3 w-3" />
      {maturity} Maturity
    </span>
  );
}

// ─── Timeline Step Component ────────────────────────────────────────────────
function TimelineStepCard({
  step,
  delay,
  visible,
}: {
  step: ReplayStep;
  delay: number;
  visible: boolean;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!visible) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [visible, delay]);

  const StageIcon = STAGE_ICONS[step.stage_id] ?? Activity;
  const isSentinel = step.is_sentinel_intervention;

  return (
    <div
      className="transition-all duration-500"
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateX(0)' : 'translateX(-16px)',
      }}
    >
      <div
        className="flex gap-3"
      >
        {/* Icon */}
        <div className="flex flex-col items-center">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{
              background: isSentinel ? '#0ea5e9' : '#1e3a8a',
              boxShadow: isSentinel ? '0 0 12px #0ea5e980' : undefined,
            }}
          >
            <StageIcon className="h-4 w-4 text-white" />
          </div>
        </div>

        {/* Content */}
        <div
          className="flex-1 rounded-[var(--radius-input)] border p-3 mb-3"
          style={{
            borderColor: isSentinel ? '#0ea5e940' : 'var(--border)',
            background: isSentinel ? '#0ea5e908' : 'var(--surface)',
          }}
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span
              className="text-sm font-semibold"
              style={{ color: isSentinel ? '#0ea5e9' : 'var(--text)' }}
            >
              {step.title}
            </span>
            <span className="text-xs text-text-muted font-mono">
              {new Date(step.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-xs text-text-muted">{step.description}</p>
          {step.evidence.length > 0 && (
            <div className="mt-2 space-y-1">
              {step.evidence.map((ev, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 rounded px-2 py-1 text-xs"
                  style={{ background: 'var(--bg)' }}
                >
                  <Info className="h-3 w-3 shrink-0 mt-0.5 text-accent" />
                  <span className="text-text-muted">{ev.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Predicted Stage Card ────────────────────────────────────────────────────
function PredictedStageCard({
  stage,
  index,
  visible,
}: {
  stage: PredictedStage;
  index: number;
  visible: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!visible) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), 200 + index * 150);
    return () => clearTimeout(t);
  }, [visible, index]);

  const StageIcon = STAGE_ICONS[stage.stage_id] ?? Activity;
  const danger = stage.confidence >= 0.65 ? '#dc2626' : stage.confidence >= 0.4 ? '#ea580c' : '#d97706';

  return (
    <div
      className="transition-all duration-500"
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(12px)',
      }}
    >
      <div
        className="rounded-[var(--radius-input)] border p-4 cursor-pointer hover:border-opacity-60 transition-colors"
        style={{ borderColor: `${danger}40`, background: `${danger}08` }}
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded((x) => !x)}
      >
        <div className="flex items-center gap-3 mb-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
            style={{ background: `${danger}20` }}
          >
            <StageIcon className="h-4 w-4" style={{ color: danger }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text">{stage.stage_name}</span>
              <span
                className="text-xs px-1.5 py-0.5 rounded font-mono"
                style={{ background: `${danger}15`, color: danger }}
              >
                {stage.probability_label}
              </span>
            </div>
            <p className="text-xs text-text-muted">{stage.kill_chain_phase}</p>
          </div>
          <ChevronRight
            className="h-4 w-4 text-text-muted shrink-0 transition-transform"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          />
        </div>

        {confidenceBar(stage.confidence)}

        {expanded && (
          <div className="mt-3 space-y-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            <p className="text-xs text-text-muted leading-relaxed">{stage.explanation}</p>

            {stage.supporting_evidence.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-text mb-1.5">Supporting Evidence</p>
                <ul className="space-y-1">
                  {stage.supporting_evidence.map((ev, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-text-muted">
                      <Info className="h-3 w-3 shrink-0 mt-0.5 text-accent" />
                      {ev}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {stage.recommended_actions.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-text mb-1.5">Immediate Actions</p>
                <ul className="space-y-1">
                  {stage.recommended_actions.slice(0, 4).map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-text-muted">
                      <Zap className="h-3 w-3 shrink-0 mt-0.5" style={{ color: danger }} />
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sentinel Response Panel ─────────────────────────────────────────────────
function SentinelResponsePanel({
  steps,
  visible,
}: {
  steps: SentinelResponseStep[];
  visible: boolean;
}) {
  const [shownCount, setShownCount] = useState(0);

  useEffect(() => {
    if (!visible) { setShownCount(0); return; }
    setShownCount(0);
    steps.forEach((_, i) => {
      setTimeout(() => setShownCount((c) => Math.max(c, i + 1)), 300 + i * 600);
    });
  }, [visible, steps]);

  return (
    <div className="space-y-2">
      {steps.map((step, i) => {
        const shown = i < shownCount;
        const isContained = step.action === 'Attack Contained';
        return (
          <div
            key={step.step_index}
            className="transition-all duration-500"
            style={{
              opacity: shown ? 1 : 0,
              transform: shown ? 'translateX(0)' : 'translateX(16px)',
            }}
          >
            <div
              className="flex items-start gap-3 rounded-[var(--radius-input)] border p-3"
              style={{
                borderColor: isContained ? '#05966940' : '#0ea5e930',
                background: isContained ? '#05966908' : '#0ea5e908',
              }}
            >
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white text-xs font-bold mt-0.5"
                style={{ background: isContained ? '#059669' : '#0ea5e9' }}
              >
                {isContained ? <CheckCircle2 className="h-3.5 w-3.5" /> : step.step_index}
              </div>
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: isContained ? '#059669' : '#0ea5e9' }}
                >
                  {step.action}
                </p>
                <p className="text-xs text-text-muted">{step.outcome}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Evidence Panel ──────────────────────────────────────────────────────────
function EvidencePanel({ signals, visible }: { signals: EvidenceSignal[]; visible: boolean }) {
  return (
    <div className="space-y-2">
      {signals.map((sig, i) => {
        const hasShap = sig.shap_attribution !== 0;
        return (
          <div
            key={i}
            className="flex items-start gap-3 rounded-[var(--radius-input)] border border-border bg-bg p-3"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10">
              <Activity className="h-3 w-3 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <code className="text-xs font-mono text-text bg-surface px-1.5 py-0.5 rounded border border-border">
                  {sig.feature}
                </code>
                {sig.value !== null && sig.value !== undefined && (
                  <span className="text-xs text-text-muted font-mono">= {String(sig.value)}</span>
                )}
                {hasShap && (
                  <span
                    className="text-xs font-mono px-1 py-0.5 rounded"
                    style={{
                      background: sig.shap_attribution > 0 ? '#dc262615' : '#05966915',
                      color: sig.shap_attribution > 0 ? '#dc2626' : '#059669',
                    }}
                  >
                    SHAP {sig.shap_attribution > 0 ? '+' : ''}{sig.shap_attribution.toFixed(3)}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted">{sig.description}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {sig.stage_hints.map((h) => (
                  <span
                    key={h}
                    className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: '#1e3a8a20', color: '#1e3a8a' }}
                  >
                    {h.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function AttackReplayPage() {
  const [selectedScenario, setSelectedScenario] = useState<Scenario>(SCENARIOS[0]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AttackReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'replay' | 'predict' | 'evidence' | 'sentinel'>('replay');
  const [replayVisible, setReplayVisible] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runInvestigation = async (scenario: Scenario) => {
    setLoading(true);
    setData(null);
    setError(null);
    setReplayVisible(false);

    try {
      // Route through NestJS backend (localhost:3001/api/sentinel/investigate)
      // so the browser never talks to the Sentinel API directly.
      const resp = await api.post<AttackReplayResponse>(
        `/sentinel/investigate?sentinel_mode=true`,
        { ...scenario.payload, event_time: new Date().toISOString() },
      );
      setData(resp.data);
      setActiveTab('replay');
      setTimeout(() => setReplayVisible(true), 300);
    } catch (e) {
      setError(apiError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleScenario = (s: Scenario) => {
    setSelectedScenario(s);
    setData(null);
    setError(null);
    setReplayVisible(false);
  };

  const reset = () => {
    setData(null);
    setError(null);
    setReplayVisible(false);
  };

  // Auto-play through scenarios
  useEffect(() => {
    if (!autoPlay) {
      if (autoRef.current) clearInterval(autoRef.current);
      return;
    }
    let idx = SCENARIOS.findIndex((s) => s.id === selectedScenario.id);
    autoRef.current = setInterval(() => {
      idx = (idx + 1) % SCENARIOS.length;
      const next = SCENARIOS[idx];
      setSelectedScenario(next);
      runInvestigation(next);
    }, 12_000);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay]);

  const tabs = [
    { id: 'replay' as const, label: 'Attack Replay', icon: Play },
    { id: 'predict' as const, label: 'Next Attack Prediction', icon: TrendingUp },
    { id: 'evidence' as const, label: 'Evidence Signals', icon: Activity },
    { id: 'sentinel' as const, label: 'Sentinel Response', icon: Shield },
  ];

  return (
    <div className="space-y-6 max-w-[1200px]">
      <PageHeader
        title="AI Attack Replay & Prediction"
        description="Real-time cyber attack reconstruction powered by Sentinel Fusion AI — maps observed evidence to MITRE ATT&CK stages and predicts the attacker's next move."
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
              <Radio className="h-3 w-3 animate-pulse" />
              Live AI Engine
            </span>
          </div>
        }
      />

      {/* ── How it works banner ── */}
      <div className="rounded-[var(--radius-card)] border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
          <div className="text-sm text-text-muted space-y-1">
            <p>
              <strong className="text-text">How it works:</strong> Select an attack scenario below.
              Sentinel&apos;s Cyber Watcher AI scores the event in real time, maps SHAP feature
              attributions to{' '}
              <strong className="text-text">MITRE ATT&amp;CK tactics</strong>, walks back the kill
              chain to reconstruct what already happened, and predicts the most probable next stages
              with confidence scores — all deterministically, with no generative AI.
            </p>
          </div>
        </div>
      </div>

      {/* ── Scenario Selector ── */}
      <div>
        <p className="text-sm font-medium text-text mb-3">Choose an attack scenario:</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SCENARIOS.map((s) => {
            const Icon = s.icon;
            const active = selectedScenario.id === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handleScenario(s)}
                className="text-left rounded-[var(--radius-card)] border p-4 transition-all duration-200"
                style={{
                  borderColor: active ? `${s.color}60` : 'var(--border)',
                  background: active ? `${s.color}0d` : 'var(--surface)',
                  boxShadow: active ? `0 0 0 2px ${s.color}30` : undefined,
                }}
              >
                <div
                  className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg"
                  style={{ background: `${s.color}20` }}
                >
                  <Icon className="h-4 w-4" style={{ color: s.color }} />
                </div>
                <p
                  className="text-sm font-semibold mb-0.5"
                  style={{ color: active ? s.color : 'var(--text)' }}
                >
                  {s.label}
                </p>
                <p className="text-xs text-text-muted leading-snug">{s.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Action row ── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => runInvestigation(selectedScenario)}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-[var(--radius-input)] px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-60"
          style={{ background: selectedScenario.color }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          {loading ? 'Investigating…' : `Investigate: ${selectedScenario.label}`}
        </button>

        {data && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text-muted hover:text-text transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        )}

        <label className="ml-auto flex items-center gap-2 cursor-pointer select-none">
          <span className="text-xs text-text-muted">Auto-cycle demo</span>
          <button
            type="button"
            onClick={() => {
              const next = !autoPlay;
              setAutoPlay(next);
              if (next) runInvestigation(selectedScenario);
            }}
            className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
            style={{ background: autoPlay ? '#0ea5e9' : 'var(--border)' }}
          >
            <span
              className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
              style={{ transform: autoPlay ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </button>
        </label>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-risk-critical/30 bg-risk-critical/5 p-4">
          <XCircle className="h-4 w-4 shrink-0 text-risk-critical mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-risk-critical">Investigation failed</p>
            <p className="text-xs text-text-muted">{error}</p>
          </div>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <div className="flex items-center gap-3 mb-6">
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <span className="text-sm font-medium text-text">Sentinel AI is analysing the event…</span>
          </div>
          <div className="space-y-3">
            {['Scoring with Cyber Watcher model', 'Computing SHAP attributions', 'Mapping MITRE ATT&CK stages', 'Predicting attack progression'].map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <div
                  className="h-1.5 w-1.5 rounded-full animate-pulse"
                  style={{ background: '#0ea5e9', animationDelay: `${i * 200}ms` }}
                />
                <span className="text-xs text-text-muted">{step}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Result ── */}
      {data && !loading && (
        <>
          {/* Incident header */}
          <div
            className="rounded-[var(--radius-card)] border p-5"
            style={{
              borderColor: `${riskColor(data.risk_level)}40`,
              background: `${riskColor(data.risk_level)}08`,
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h2 className="text-lg font-bold text-text">
                    Incident: {data.incident_id}
                  </h2>
                  <RiskPill level={data.risk_level} />
                  <MaturityPill maturity={data.attack_maturity} />
                </div>
                <p className="text-sm text-text-muted max-w-2xl">{data.ai_summary}</p>
              </div>

              <div className="text-right shrink-0">
                <div
                  className="text-3xl font-bold tabular"
                  style={{ color: riskColor(data.risk_level) }}
                >
                  {(data.risk_score * 100).toFixed(1)}
                  <span className="text-base font-normal text-text-muted">/100</span>
                </div>
                <p className="text-xs text-text-muted">AI Risk Score</p>
                <div className="mt-1 flex items-center gap-1 justify-end">
                  <Activity className="h-3 w-3 text-text-muted" />
                  <span className="text-xs text-text-muted">
                    Confidence {(data.investigation_confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Current stage pill */}
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-muted">Current stage:</span>
              <div
                className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold"
                style={{ background: `${riskColor(data.risk_level)}20`, color: riskColor(data.risk_level) }}
              >
                {data.current_stage.stage_name}
                <span className="text-xs font-mono opacity-70">{data.current_stage.mitre_tactic_id}</span>
              </div>
              <span className="text-xs text-text-muted">{data.current_stage.kill_chain_phase} phase</span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-2">
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className="inline-flex items-center gap-2 rounded-[var(--radius-input)] border px-4 py-2 text-sm font-medium transition-all"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    background: active ? 'rgba(6,182,212,0.1)' : 'var(--surface)',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                  {t.id === 'predict' && (
                    <span
                      className="ml-1 rounded-full px-1.5 py-0.5 text-xs font-bold"
                      style={{ background: '#dc262620', color: '#dc2626' }}
                    >
                      {data.predicted_stages.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            {/* Left: main panel */}
            <div className="lg:col-span-3">
              {activeTab === 'replay' && (
                <div
                  className="rounded-[var(--radius-card)] border border-border bg-surface p-5"
                >
                  <h3 className="text-sm font-semibold text-text mb-4 flex items-center gap-2">
                    <Play className="h-4 w-4 text-accent" />
                    Attack Kill Chain Replay
                  </h3>
                  <div>
                    {data.replay_timeline.map((step, i) => (
                      <TimelineStepCard
                        key={step.step_index}
                        step={step}
                        delay={i * 400}
                        visible={replayVisible}
                      />
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'predict' && (
                <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
                  <h3 className="text-sm font-semibold text-text mb-1 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-accent" />
                    Most Probable Next Attack Stages
                  </h3>
                  <p className="text-xs text-text-muted mb-4">
                    Derived from MITRE ATT&amp;CK transition probabilities, current risk score, and
                    observed evidence. Click any stage to expand.
                  </p>
                  <div className="space-y-3">
                    {data.predicted_stages.map((ps, i) => (
                      <PredictedStageCard
                        key={ps.stage_id}
                        stage={ps}
                        index={i}
                        visible={true}
                      />
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'evidence' && (
                <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
                  <h3 className="text-sm font-semibold text-text mb-1 flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    Observed Evidence Signals
                  </h3>
                  <p className="text-xs text-text-muted mb-4">
                    SHAP-attributed features from Cyber Watcher + deterministic raw event field
                    rules. Each signal maps to one or more MITRE ATT&amp;CK stages.
                  </p>
                  {data.observed_evidence.length > 0 ? (
                    <EvidencePanel signals={data.observed_evidence} visible />
                  ) : (
                    <p className="text-sm text-text-muted">No evidence signals detected. The model may have scored on statistical features without interpretable raw signals.</p>
                  )}
                </div>
              )}

              {activeTab === 'sentinel' && (
                <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
                  <h3 className="text-sm font-semibold text-text mb-1 flex items-center gap-2">
                    <Shield className="h-4 w-4 text-accent" />
                    With Sentinel — Defensive Response
                  </h3>
                  <p className="text-xs text-text-muted mb-4">
                    Automated containment actions Sentinel takes at the{' '}
                    <strong>{data.current_stage.stage_name}</strong> stage to prevent further attack
                    progression.
                  </p>
                  <SentinelResponsePanel steps={data.sentinel_response} visible />
                </div>
              )}
            </div>

            {/* Right: summary sidebar */}
            <div className="lg:col-span-2 space-y-4">
              {/* Kill chain progress */}
              <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
                  Kill Chain Progress
                </h3>
                <div className="space-y-2">
                  {data.completed_stages.map((stage) => {
                    const Icon = STAGE_ICONS[stage.stage_id] ?? Activity;
                    return (
                      <div key={stage.stage_id} className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-risk-critical" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5 text-text-muted shrink-0" />
                            <span className="text-xs font-medium text-text truncate">
                              {stage.stage_name}
                            </span>
                          </div>
                        </div>
                        <span className="text-xs font-mono text-text-muted shrink-0">
                          {stage.mitre_tactic_id}
                        </span>
                      </div>
                    );
                  })}

                  {/* Current stage */}
                  <div className="flex items-center gap-2">
                    <div
                      className="h-4 w-4 shrink-0 rounded-full animate-pulse border-2"
                      style={{ borderColor: riskColor(data.risk_level), background: `${riskColor(data.risk_level)}30` }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-xs font-semibold"
                          style={{ color: riskColor(data.risk_level) }}
                        >
                          {data.current_stage.stage_name}
                        </span>
                        <span className="text-xs text-text-muted">(NOW)</span>
                      </div>
                    </div>
                    <span className="text-xs font-mono text-text-muted shrink-0">
                      {data.current_stage.mitre_tactic_id}
                    </span>
                  </div>

                  {/* Predicted */}
                  {data.predicted_stages.slice(0, 2).map((ps) => {
                    const Icon = STAGE_ICONS[ps.stage_id] ?? Activity;
                    const danger = ps.confidence >= 0.65 ? '#dc2626' : '#ea580c';
                    return (
                      <div key={ps.stage_id} className="flex items-center gap-2 opacity-50">
                        <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: danger }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5 text-text-muted shrink-0" />
                            <span className="text-xs text-text-muted truncate">{ps.stage_name}</span>
                          </div>
                        </div>
                        <span className="text-xs font-mono" style={{ color: danger }}>
                          {(ps.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Without Sentinel */}
              <div className="rounded-[var(--radius-card)] border border-risk-critical/20 bg-risk-critical/5 p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-risk-critical mb-3 flex items-center gap-1.5">
                  <XCircle className="h-3.5 w-3.5" />
                  Without Sentinel
                </h3>
                <div className="space-y-1.5">
                  {data.predicted_stages.slice(0, 3).map((ps) => (
                    <div key={ps.stage_id} className="flex items-center gap-2 text-xs text-text-muted">
                      <ChevronRight className="h-3 w-3 text-risk-critical shrink-0" />
                      {ps.stage_name}
                    </div>
                  ))}
                  <div className="flex items-center gap-2 text-xs font-semibold text-risk-critical">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Business Disruption
                  </div>
                </div>
              </div>

              {/* With Sentinel */}
              <div className="rounded-[var(--radius-card)] border border-green-500/20 bg-green-500/5 p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-green-600 mb-3 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  With Sentinel
                </h3>
                <div className="space-y-1.5">
                  {data.sentinel_response.slice(0, -1).map((s) => (
                    <div key={s.step_index} className="flex items-center gap-2 text-xs text-text-muted">
                      <ChevronRight className="h-3 w-3 text-green-500 shrink-0" />
                      {s.action}
                    </div>
                  ))}
                  <div className="flex items-center gap-2 text-xs font-semibold text-green-600">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    Attack Contained ✓
                  </div>
                </div>
              </div>

              {/* Model metadata */}
              <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                  Model Metadata
                </h3>
                <dl className="space-y-1">
                  {[
                    ['Model', data.score.model],
                    ['Version', data.model_version],
                    ['Raw score', data.score.risk_score?.toFixed(4)],
                    ['Confidence', `${(data.investigation_confidence * 100).toFixed(0)}%`],
                    ['Evidence signals', String(data.observed_evidence.length)],
                    ['Predicted stages', String(data.predicted_stages.length)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <dt className="text-xs text-text-muted">{k}</dt>
                      <dd className="text-xs font-mono text-text">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface p-12 text-center">
          <Shield className="h-12 w-12 mx-auto mb-4 text-border" />
          <h3 className="text-base font-semibold text-text mb-2">
            Select a scenario and click Investigate
          </h3>
          <p className="text-sm text-text-muted max-w-md mx-auto">
            Sentinel AI will score the event with Cyber Watcher, reconstruct the attack timeline,
            and predict the attacker&apos;s next moves — all in real time.
          </p>
        </div>
      )}
    </div>
  );
}
