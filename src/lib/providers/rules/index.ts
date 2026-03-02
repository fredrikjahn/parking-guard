import type { RulesProvider } from './types';
import { stockholmLtfProvider } from './stockholmLtf';

const providers: Record<string, RulesProvider> = {
  [stockholmLtfProvider.key]: stockholmLtfProvider,
};

export function getRulesProvider(key: string): RulesProvider | undefined {
  return providers[key];
}

export function listRulesProviders(): RulesProvider[] {
  return Object.values(providers);
}
