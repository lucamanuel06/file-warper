/** Synthetic `Converter` builder for graph/registry unit tests — never a real engine. */

import type { Availability, Converter, EdgeCost } from '@core/types';

export function fake(
  id: string,
  inputs: readonly string[],
  outputs: readonly string[],
  cost: Partial<EdgeCost> = {},
  overrides: Partial<Converter> = {},
): Converter {
  const fixedCost: EdgeCost = { retention: 1, effort: 1, ...cost };
  return {
    id,
    name: id,
    engine: 'pure-js',
    inputs,
    outputs,
    cost: () => fixedCost,
    availability: async (): Promise<Availability> => ({ available: true }),
    convert: async () => {
      throw new Error(`fake converter "${id}" is not runnable`);
    },
    ...overrides,
  };
}
