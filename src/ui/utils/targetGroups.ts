import { CATEGORY_ORDER, getFormat } from '@core/formats';
import type { FormatCategory, FormatId, TargetSet } from '@core/types';
import { shortFormatLabel } from './format';

export interface TargetOption {
  readonly value: FormatId;
  readonly label: string;
}

export interface TargetGroup {
  readonly label: string;
  readonly options: readonly TargetOption[];
}

function toOption(def: NonNullable<ReturnType<typeof getFormat>>): TargetOption {
  return { value: def.id, label: shortFormatLabel(def) };
}

function categoryLabel(cat: FormatCategory): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

/** Suggested (~6, same-category, lossless-first, popular) then one group per category. */
export function buildTargetGroups(
  targetSet: TargetSet | null,
  currentTarget: FormatId | null,
): TargetGroup[] {
  if (!targetSet) return [];
  const ids = Array.from(
    new Set([...targetSet.common, ...Object.keys(targetSet.partial)]),
  );
  const defs = ids.map(getFormat).filter((d): d is NonNullable<typeof d> => !!d);
  const currentCategory = currentTarget ? getFormat(currentTarget)?.category : undefined;
  const sameCategory = currentCategory
    ? defs.filter((d) => d.category === currentCategory)
    : defs;
  const suggested = [...sameCategory]
    .sort((a, b) => Number(a.lossy) - Number(b.lossy) || b.popularity - a.popularity)
    .slice(0, 6);
  const suggestedIds = new Set(suggested.map((d) => d.id));

  const groups: TargetGroup[] = [];
  if (suggested.length)
    groups.push({ label: 'Suggested', options: suggested.map(toOption) });
  for (const cat of CATEGORY_ORDER) {
    const rest = defs.filter((d) => d.category === cat && !suggestedIds.has(d.id));
    if (rest.length)
      groups.push({ label: categoryLabel(cat), options: rest.map(toOption) });
  }
  return groups;
}
