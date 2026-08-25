import type { Converter } from '@core/types';
import { docToText } from './doc-txt';
import { docxToHtml } from './docx-html';
import { epubToHtml } from './epub-html';
import { htmlToDocxConverter } from './html-to-docx';
import { htmlToEpubConverter } from './html-to-epub';
import { htmlToMdConverter } from './html-to-md';
import { htmlToPdfConverter } from './html-to-pdf';
import { htmlToTxtConverter } from './html-to-txt';
import { libreOfficeConverter } from './libreoffice';
import { mdToHtml } from './md-html';
import { odpToHtml, odtToHtml, pptxToHtml } from './office-zip-html';
import { pdfToText } from './pdf-text';
import { rtfToHtml } from './rtf-html';
import { spreadsheetReadConverter, spreadsheetWriteConverter } from './spreadsheet';

export const documentConverters: Converter[] = [
  // Parsers: X -> html (or txt, for the text-fidelity-only doc converter)
  mdToHtml,
  docxToHtml,
  pdfToText,
  rtfToHtml,
  docToText,
  odtToHtml,
  odpToHtml,
  pptxToHtml,
  epubToHtml,
  // Writers: html -> Y
  htmlToPdfConverter,
  htmlToTxtConverter,
  htmlToMdConverter,
  htmlToDocxConverter,
  htmlToEpubConverter,
  // Spreadsheets: xlsx/xls/ods <-> csv/tsv/json/html
  spreadsheetReadConverter,
  spreadsheetWriteConverter,
  // Optional high-fidelity Office bridge, detected at runtime
  libreOfficeConverter,
];
