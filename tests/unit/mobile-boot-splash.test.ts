import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const mobileHtml = read('src/renderer/mobile.html');
const cspOf = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];

describe('mobile boot splash', () => {
  it('keeps the CSP byte-identical to index.html', () => {
    expect(cspOf(mobileHtml)).toBeDefined();
    expect(cspOf(mobileHtml)).toBe(cspOf(read('src/renderer/index.html')));
  });
  it('ships a gem splash sibling that is hidden once #app has children', () => {
    expect(mobileHtml).toContain('id="boot-splash"');
    expect(mobileHtml).toContain('#789348');
    expect(mobileHtml).toContain('#app:not(:empty) ~ #boot-splash');
    expect(mobileHtml.indexOf('id="app"')).toBeLessThan(mobileHtml.indexOf('id="boot-splash"'));
  });
  it('uses no inline scripts (CSP forbids them) and loads the boot-error script first', () => {
    expect(/<script(?![^>]*\bsrc=)[^>]*>/.test(mobileHtml)).toBe(false);
    expect(mobileHtml.indexOf('./boot-error.js')).toBeGreaterThan(-1);
    expect(mobileHtml.indexOf('./boot-error.js')).toBeLessThan(mobileHtml.indexOf('./mobile-renderer.js'));
  });
  it('has a failed-load fallback that is copied into dist/mobile', () => {
    expect(mobileHtml).toContain('id="boot-error"');
    expect(read('src/renderer/mobile-boot-error.js')).toContain('unhandledrejection');
    expect(read('esbuild.config.mjs')).toContain('"dist/mobile/boot-error.js"');
  });
});

describe('iOS launch screen', () => {
  const splash = readFileSync(new URL('../../ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', import.meta.url));
  it('has a dark storyboard background, not systemBackgroundColor', () => {
    const sb = read('ios/App/App/Base.lproj/LaunchScreen.storyboard');
    expect(sb).not.toContain('systemBackgroundColor');
    expect(sb).toContain('red="0.1176');
  });
  it('splash PNG is an opaque RGB image, not the stale Capacitor default', () => {
    expect(splash.readUInt32BE(16)).toBe(2732);
    expect(splash[25]).toBe(2);
  });
});
