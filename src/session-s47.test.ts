/**
 * Session 47 — BUILD: GAP-4 fix + open-source readiness tests
 *
 * Tests:
 * - GAP-4 fix: U+2061-U+2064 now stripped by content filter
 * - LICENSE file exists and is MIT
 * - CONTRIBUTING.md exists
 * - CHANGELOG.md exists
 */

import { describe, it, expect } from 'vitest';
import { filterSensitiveContent } from './core/compressor.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

describe('Session 47: GAP-4 Fix — U+2061-U+2064 invisible math chars now stripped', () => {
  const invisibleChars = [
    { code: '\u2061', name: 'function application' },
    { code: '\u2062', name: 'invisible times' },
    { code: '\u2063', name: 'invisible separator' },
    { code: '\u2064', name: 'invisible plus' },
  ];

  for (const { code, name } of invisibleChars) {
    it(`strips U+${code.charCodeAt(0).toString(16).toUpperCase()} (${name}) from GitHub token`, () => {
      // Insert invisible char mid-token — should be stripped, token caught
      const payload = `ghp_${'A'.repeat(20)}${code}${'B'.repeat(20)}`;
      const { sanitized, redactions } = filterSensitiveContent(payload);
      expect(redactions.length).toBeGreaterThan(0);
      expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(sanitized).not.toContain(code);
    });

    it(`strips U+${code.charCodeAt(0).toString(16).toUpperCase()} (${name}) from password pattern`, () => {
      const payload = `pass${code}word=secret123`;
      const { sanitized, redactions } = filterSensitiveContent(payload);
      expect(redactions.length).toBeGreaterThan(0);
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
    });

    it(`strips U+${code.charCodeAt(0).toString(16).toUpperCase()} (${name}) from AWS key`, () => {
      const payload = `AKIA${code}${'A'.repeat(16)}`;
      const { sanitized, redactions } = filterSensitiveContent(payload);
      expect(redactions.length).toBeGreaterThan(0);
      expect(sanitized).toContain('[REDACTED_AWS_KEY]');
    });
  }

  it('strips all four invisible math chars when combined in single token', () => {
    const payload = `ghp_${'A'.repeat(10)}\u2061${'B'.repeat(10)}\u2062${'C'.repeat(10)}\u2063${'D'.repeat(10)}\u2064`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('U+2060 (word joiner) still stripped (regression check)', () => {
    const payload = `ghp_${'A'.repeat(20)}\u2060${'B'.repeat(20)}`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('JWT with invisible separator mid-token is caught', () => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payloadPart = Buffer.from('{"sub":"1"}').toString('base64url');
    const sig = 'a'.repeat(43);
    const jwt = `${header}.\u2063${payloadPart}.${sig}`;
    const { sanitized, redactions } = filterSensitiveContent(jwt);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_JWT]');
  });

  it('bearer token with invisible plus is caught', () => {
    const payload = `Bearer eyJ\u2064${'a'.repeat(50)}`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_TOKEN]');
  });

  it('Slack token with invisible times is caught', () => {
    const payload = `xoxb-${'1'.repeat(10)}-${'2'.repeat(10)}\u2062-${'a'.repeat(24)}`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('PEM key with invisible chars scattered is caught', () => {
    const payload = `-----BEGIN\u2061 PRIVATE KEY-----\nMIIE\u2063v${'A'.repeat(40)}\n-----END PRIVATE KEY-----`;
    const { sanitized, redactions } = filterSensitiveContent(payload);
    expect(redactions.length).toBeGreaterThan(0);
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('double-pass is idempotent after fix', () => {
    const payload = `ghp_${'A'.repeat(20)}\u2063${'B'.repeat(20)}`;
    const first = filterSensitiveContent(payload);
    const second = filterSensitiveContent(first.sanitized);
    expect(second.redactions.length).toBe(0); // nothing new to redact
    expect(second.sanitized).toBe(first.sanitized);
  });
});

describe('Session 47: Open-Source Readiness', () => {
  const projectRoot = resolve(import.meta.dirname, '..');

  it('LICENSE file exists and is MIT', () => {
    const licensePath = resolve(projectRoot, 'LICENSE');
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('MIT License');
  });

  it('CONTRIBUTING.md exists', () => {
    expect(existsSync(resolve(projectRoot, 'CONTRIBUTING.md'))).toBe(true);
  });

  it('CHANGELOG.md exists', () => {
    expect(existsSync(resolve(projectRoot, 'CHANGELOG.md'))).toBe(true);
  });

  it('README.md has installation instructions', () => {
    const content = readFileSync(resolve(projectRoot, 'README.md'), 'utf-8');
    expect(content.toLowerCase()).toContain('install');
  });

  it('package.json has required fields', () => {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('ved');
    expect(pkg.version).toBeDefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.description).toBeDefined();
    expect(pkg.bin).toBeDefined();
  });
});
