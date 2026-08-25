import type { Converter } from '@core/types';
import { bmp } from './bmp';
import { heicDecode } from './heic';
import { ico } from './ico';
import { imageToPdf } from './image-to-pdf';
import { psdDecode } from './psd';
import { sharpRaster } from './sharp-raster';
import { svgCompress } from './svg';

export const imageConverters: Converter[] = [
  sharpRaster,
  heicDecode,
  psdDecode,
  ico,
  bmp,
  svgCompress,
  imageToPdf,
];
