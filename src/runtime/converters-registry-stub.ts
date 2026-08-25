import type { Converter } from '@core/types';

/**
 * TEMPORARY STUB — see docs/PLAN.md §3. `@converters/index` (W1's barrel
 * exporting `ALL_CONVERTERS`) does not exist on this branch yet. Both the
 * worker entry point and the main-process scheduler import this single list
 * so there is exactly one place to update once it lands:
 *
 *   export { ALL_CONVERTERS as ALL_CONVERTERS_STUB } from '@converters/index';
 *
 * Registry construction, worker dispatch, and main-residency dispatch are
 * already wired against `ALL_CONVERTERS_STUB` and need no other change.
 */
export const ALL_CONVERTERS_STUB: readonly Converter[] = [];
