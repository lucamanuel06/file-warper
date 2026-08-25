import type { Converter } from '@core/types';
import { cabIsoToZipConverter } from './cab-iso-to-zip';
import { rarToZipConverter } from './rar-to-zip';
import { sevenZipRepackConverter } from './seven-zip-repack';
import { singleFileRecompressConverter } from './single-file';
import { zipTarRepackConverter } from './zip-tar';

export const archiveConverters: Converter[] = [
  zipTarRepackConverter,
  sevenZipRepackConverter,
  singleFileRecompressConverter,
  rarToZipConverter,
  cabIsoToZipConverter,
];
