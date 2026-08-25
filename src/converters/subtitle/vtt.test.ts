import { describe, expect, it } from 'vitest';
import { parseVtt, serializeVtt } from './vtt';

const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Hello there.

00:00:05.200 --> 00:00:07.800
Multi-line
subtitle text.
`;

describe('VTT parsing', () => {
  it('starts with a WEBVTT header', () => {
    expect(SAMPLE_VTT.startsWith('WEBVTT')).toBe(true);
  });

  it('parses cues, tolerating an optional cue identifier line', () => {
    const cues = parseVtt(SAMPLE_VTT);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: 'Hello there.' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.' },
    ]);
  });

  it('ignores NOTE and STYLE blocks', () => {
    const withNote = `WEBVTT

NOTE this is a comment

STYLE
::cue { color: white; }

00:00:01.000 --> 00:00:02.000
Text.
`;
    expect(parseVtt(withNote)).toEqual([{ start: 1000, end: 2000, text: 'Text.' }]);
  });
});

describe('VTT serialization', () => {
  it('emits a WEBVTT header', () => {
    const out = serializeVtt([{ start: 1000, end: 2000, text: 'Hi' }]);
    expect(out.startsWith('WEBVTT\n')).toBe(true);
    expect(out).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('round-trips cues through parse(serialize(cues))', () => {
    const cues = parseVtt(SAMPLE_VTT);
    const reparsed = parseVtt(serializeVtt(cues));
    expect(reparsed).toEqual(cues);
  });
});
