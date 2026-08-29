import { describe, it, expect } from 'vitest';
import { sanitizeCsvCell } from '../../apps/server/src/routes/export.js';

describe('CSV Export & Formula Injection Defense', () => {
  it('Neutralizes dangerous spreadsheet formula prefixes (=, +, -, @, tab, cr)', () => {
    expect(sanitizeCsvCell('=1+2')).toBe("'=1+2");
    expect(sanitizeCsvCell('+cmd|/C')).toBe("'+cmd|/C");
    expect(sanitizeCsvCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCsvCell('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
    expect(sanitizeCsvCell('\tmalicious')).toBe("'\tmalicious");
  });

  it('Correctly preserves and quotes cells with commas and quotes', () => {
    expect(sanitizeCsvCell('Normal text')).toBe('Normal text');
    expect(sanitizeCsvCell('Text, with comma')).toBe('"Text, with comma"');
    expect(sanitizeCsvCell('Text "with quotes"')).toBe('"Text ""with quotes"""');
    expect(sanitizeCsvCell('=Formula, with "quotes"')).toBe('"\'=Formula, with ""quotes"""');
  });

  it('Handles null and undefined cleanly', () => {
    expect(sanitizeCsvCell(null)).toBe('');
    expect(sanitizeCsvCell(undefined)).toBe('');
    expect(sanitizeCsvCell(0)).toBe('0');
  });
});
