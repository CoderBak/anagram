// Types for test/survey-gate.mjs — hand-written, because the gate is a runnable script
// (node test/survey-gate.mjs a.json b.json) and not part of the extension's build. Only
// what the unit test in test/node/surveyGate.test.ts touches is declared.

export interface SurveyReport {
  label?: string;
  at?: string;
  minutes?: number;
  jobs?: number;
  pages?: Record<string, unknown>[];
}

export interface GateSite {
  name: string;
  status: "regression" | "improvement" | "ok" | "skipped";
  findings: string[];
  note: string;
}

export interface GateResult {
  tool: "coverage" | "dynamics";
  baseline: { label: string; at: string | null; pages: number; jobs: number | null; minutes: number | null };
  current: { label: string; at: string | null; pages: number; jobs: number | null; minutes: number | null };
  sites: GateSite[];
  totals: { compared: number; regressions: number; improvements: number; skipped: number };
}

export declare const T: Record<string, number>;
export declare function toolOf(report: SurveyReport): "coverage" | "dynamics";
export declare function compare(baseline: SurveyReport, current: SurveyReport): GateResult;
export declare function render(result: GateResult): string;
export declare function renderReach(report: SurveyReport): string;
