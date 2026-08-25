import { describe, expect, it } from 'vitest';
import { parseTtml, serializeTtml } from './ttml';

const SAMPLE_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:01.000" end="00:00:04.000">Hello there.</p>
      <p begin="00:00:05.200" end="00:00:07.800">Multi-line<br/>subtitle text.</p>
    </div>
  </body>
</tt>
`;

function isWellFormedXml(xml: string): boolean {
  // Every opening tag (non-self-closing, non-declaration) has a matching close,
  // and tags are properly nested — checked with a simple stack scan.
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  for (const m of xml.matchAll(tagPattern)) {
    const [, closing, name, selfClosing] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (selfClosing === '/') continue;
    if (closing === '/') {
      const top = stack.pop();
      if (top !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

describe('TTML parsing', () => {
  it('parses as well-formed XML', () => {
    expect(isWellFormedXml(SAMPLE_TTML)).toBe(true);
  });

  it('parses cues from <p begin=".." end="..">, converting <br/> to newlines', () => {
    const cues = parseTtml(SAMPLE_TTML);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: 'Hello there.' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.' },
    ]);
  });

  it('decodes XML entities', () => {
    const xml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">Tom &amp; Jerry &lt;3&gt;</p></div></body></tt>`;
    expect(parseTtml(xml)).toEqual([{ start: 1000, end: 2000, text: 'Tom & Jerry <3>' }]);
  });
});

describe('TTML serialization', () => {
  it('produces well-formed XML in the tt/body/div/p shape', () => {
    const out = serializeTtml([{ start: 1000, end: 4000, text: 'Hi' }]);
    expect(isWellFormedXml(out)).toBe(true);
    expect(out).toContain('<tt xmlns="http://www.w3.org/ns/ttml">');
    expect(out).toContain('<p begin="00:00:01.000" end="00:00:04.000">Hi</p>');
  });

  it('escapes XML entities and preserves newlines as <br/>', () => {
    const out = serializeTtml([{ start: 0, end: 1000, text: 'A & B\nsecond line' }]);
    expect(out).toContain('A &amp; B<br/>second line');
    expect(isWellFormedXml(out)).toBe(true);
  });

  it('round-trips cues through parse(serialize(cues))', () => {
    const cues = parseTtml(SAMPLE_TTML);
    const reparsed = parseTtml(serializeTtml(cues));
    expect(reparsed).toEqual(cues);
  });
});
