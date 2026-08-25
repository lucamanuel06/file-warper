import type { Converter } from '@core/types';
import { archiveConverters } from './archive';
import { avConverters } from './av';
import { dataConverters } from './data';
import { documentConverters } from './document';
import { fontConverters } from './font';
import { imageConverters } from './image';
import { subtitleConverters } from './subtitle';

export const ALL_CONVERTERS: Converter[] = [
  ...imageConverters,
  ...avConverters,
  ...documentConverters,
  ...dataConverters,
  ...archiveConverters,
  ...fontConverters,
  ...subtitleConverters,
];
