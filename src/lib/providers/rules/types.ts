export type NormalizedRuleHit = {
  rule_type: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  summary: string;
  raw: unknown;
};

export type NormalizedRulesResult = {
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  hits: NormalizedRuleHit[];
};

export type RulesWithinInput = {
  config: Record<string, unknown>;
  lat: number;
  lng: number;
  radiusM: number;
};

export interface RulesProvider {
  key: string;
  rulesWithin(input: RulesWithinInput): Promise<unknown>;
  normalize(raw: unknown, now: Date): NormalizedRulesResult;
}
