import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const icon = readFileSync(new URL('../../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url));

/** App Store Connect rejects an iOS app icon that has an alpha channel (exportArchive: "Invalid large app icon"). */
describe('iOS App Store app icon', () => {
  it('is a PNG', () => {
    expect(icon.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
  it('is 1024x1024', () => {
    expect(icon.readUInt32BE(16)).toBe(1024);
    expect(icon.readUInt32BE(20)).toBe(1024);
  });
  it('has no alpha channel (PNG colour type 0 grey or 2 RGB, never 4 or 6)', () => {
    expect([0, 2]).toContain(icon[25]);
  });
  it('has no tRNS transparency chunk', () => {
    expect(icon.includes(Buffer.from('tRNS'))).toBe(false);
  });
});
