import { getRulesProvider } from '@/lib/providers/rules';
import type { RuleSeverity } from '@/lib/db/repo';
import type { ResolvedRulesSource } from './jurisdictionResolver';

type EvaluateInput = {
  lat: number;
  lng: number;
  radiusM: number;
  rulesSources: ResolvedRulesSource[];
};

export type EvaluatedRuleHit = {
  rules_source_id: string;
  rule_type: string;
  severity: RuleSeverity;
  summary: string;
  raw_json: unknown;
};

const severityRank: Record<RuleSeverity, number> = {
  INFO: 0,
  WARN: 1,
  CRITICAL: 2,
};

function maxSeverity(a: RuleSeverity, b: RuleSeverity): RuleSeverity {
  return severityRank[a] >= severityRank[b] ? a : b;
}

export async function evaluateRulesForPoint(input: EvaluateInput): Promise<{
  severity: RuleSeverity;
  hits: EvaluatedRuleHit[];
  errors: string[];
}> {
  let overall: RuleSeverity = 'INFO';
  const hits: EvaluatedRuleHit[] = [];
  const errors: string[] = [];

  for (const source of input.rulesSources) {
    const provider = getRulesProvider(source.provider_key);
    if (!provider) {
      errors.push(`Unknown rules provider: ${source.provider_key}`);
      continue;
    }

    try {
      const raw = await provider.rulesWithin({
        config: source.config,
        lat: input.lat,
        lng: input.lng,
        radiusM: input.radiusM,
      });
      const normalized = provider.normalize(raw, new Date());
      overall = maxSeverity(overall, normalized.severity);

      for (const hit of normalized.hits) {
        hits.push({
          rules_source_id: source.id,
          rule_type: hit.rule_type,
          severity: hit.severity,
          summary: hit.summary,
          raw_json: hit.raw,
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Failed provider ${source.provider_key}`);
    }
  }

  return {
    severity: overall,
    hits,
    errors,
  };
}
