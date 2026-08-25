import type { Converter } from '@core/types';
import { structuredDataConverter } from './structured';
import { tabularDataConverter } from './tabular';

export const dataConverters: Converter[] = [
  structuredDataConverter,
  tabularDataConverter,
];
