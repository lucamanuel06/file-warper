import { ALL_CONVERTERS } from '@converters/index';
import type { Converter } from '@core/types';

/**
 * The single list every runtime consumer imports: the worker entry point, the
 * main-process scheduler, and the IPC layer.
 *
 * This was a stub while the five workstreams were built in parallel (W2 had no
 * `@converters/index` on its branch). It is now wired to the real barrel — the
 * one-line change W2 documented as the integration point.
 */
export const ALL_CONVERTERS_STUB: readonly Converter[] = ALL_CONVERTERS;
