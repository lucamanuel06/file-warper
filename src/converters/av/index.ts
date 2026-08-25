import type { Converter } from '@core/types';
import { avTranscode } from './av-transcode';

export const avConverters: Converter[] = [avTranscode];
