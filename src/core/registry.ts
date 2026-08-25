/**
 * @warp/core — converter registry.
 *
 * Holds every registered `Converter`, tracks per-converter availability, and
 * bumps `graphVersion` whenever availability changes so `Router` knows its
 * cached routes are stale.
 */

import { FORMAT_BY_ID } from './formats';
import type { Availability, Converter, ConverterId } from './types';

export class ConverterRegistry {
  private readonly byId = new Map<ConverterId, Converter>();
  private readonly availabilityById = new Map<ConverterId, Availability>();

  /** Increments whenever availability changes -> invalidates route caches. */
  graphVersion = 0;

  /**
   * Throws on a duplicate `ConverterId` or a declared `FormatId` that does
   * not exist in the format registry — a typo here must be a startup crash
   * in dev, not a silently unreachable graph node.
   */
  register(converter: Converter): void {
    if (this.byId.has(converter.id)) {
      throw new Error(`ConverterRegistry: duplicate converter id "${converter.id}"`);
    }
    for (const format of [...converter.inputs, ...converter.outputs]) {
      if (!FORMAT_BY_ID.has(format)) {
        throw new Error(
          `ConverterRegistry: converter "${converter.id}" declares unknown format "${format}"`,
        );
      }
    }
    this.byId.set(converter.id, converter);
  }

  /**
   * Refreshes every converter's `availability()`. Cheap and never throws —
   * a converter whose own `availability()` throws is treated as unavailable
   * rather than taking the whole refresh down.
   */
  async refreshAvailability(): Promise<void> {
    let changed = false;
    for (const converter of this.byId.values()) {
      const previous = this.availabilityById.get(converter.id);
      let next: Availability;
      try {
        next = await converter.availability();
      } catch (err) {
        next = {
          available: false,
          reason: err instanceof Error ? err.message : 'availability() threw',
        };
      }
      if (!previous || !availabilityEqual(previous, next)) changed = true;
      this.availabilityById.set(converter.id, next);
    }
    if (changed) this.graphVersion++;
  }

  availableConverters(): Converter[] {
    return [...this.byId.values()].filter(
      (c) => this.availabilityById.get(c.id)?.available === true,
    );
  }

  allConverters(): Converter[] {
    return [...this.byId.values()];
  }

  getConverter(id: ConverterId): Converter | undefined {
    return this.byId.get(id);
  }

  getAvailability(id: ConverterId): Availability | undefined {
    return this.availabilityById.get(id);
  }

  availabilitySnapshot(): Record<ConverterId, Availability> {
    return Object.fromEntries(this.availabilityById);
  }
}

function availabilityEqual(a: Availability, b: Availability): boolean {
  if (a.available !== b.available) return false;
  if (a.available && b.available) return a.version === b.version;
  if (!a.available && !b.available) return a.reason === b.reason && a.remedy === b.remedy;
  return false;
}
