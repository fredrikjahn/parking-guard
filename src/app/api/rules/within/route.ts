import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveRulesSourcesForPosition } from '@/lib/engine/jurisdictionResolver';
import { evaluateRulesForPoint } from '@/lib/engine/ruleEvaluator';

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().positive().max(500).default(50),
});

export async function GET(req: NextRequest) {
  const parse = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.flatten() }, { status: 400 });
  }

  const { lat, lng, radius } = parse.data;
  const resolved = await resolveRulesSourcesForPosition(lat, lng);
  const evaluation = await evaluateRulesForPoint({
    lat,
    lng,
    radiusM: radius,
    rulesSources: resolved.rulesSources,
  });

  return NextResponse.json({
    ok: true,
    jurisdiction: resolved.jurisdiction,
    providerCount: resolved.rulesSources.length,
    ...evaluation,
  });
}
