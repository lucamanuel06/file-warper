import { describe, expect, it } from 'vitest';
import { parseAss, serializeAss } from './ass';

const SAMPLE_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello {\\i1}there{\\i0}.
Dialogue: 0,0:00:05.20,0:00:07.80,Default,,0,0,0,,Multi-line\\Nsubtitle text.
`;

describe('ASS parsing', () => {
  it('strips override tags and normalizes \\N to newlines', () => {
    const cues = parseAss(SAMPLE_ASS);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: 'Hello there.', style: 'Default' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.', style: 'Default' },
    ]);
  });
});

describe('ASS serialization', () => {
  it('emits a minimally valid file with required sections', () => {
    const out = serializeAss([{ start: 1000, end: 4000, text: 'Hi' }]);
    expect(out).toContain('[Script Info]');
    expect(out).toContain('[V4+ Styles]');
    expect(out).toContain('[Events]');
    expect(out).toContain(
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    );
    expect(out).toContain('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hi');
  });

  it('round-trips plain (tag-free) cue text', () => {
    const cues = [
      { start: 1000, end: 4000, text: 'Hello there.', style: 'Default' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.', style: 'Default' },
    ];
    const reparsed = parseAss(serializeAss(cues));
    expect(reparsed).toEqual(cues);
  });
});
