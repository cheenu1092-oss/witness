/**
 * Tests for GAP-2: Content filtering in Compressor (Session 41).
 *
 * Validates that sensitive data (API keys, passwords, tokens, private keys,
 * connection strings) is stripped before entity upsert to the vault.
 */

import { describe, it, expect } from 'vitest';
import { filterSensitiveContent } from './compressor.js';

describe('GAP-2: Content Filtering', () => {
  describe('API keys', () => {
    it('redacts generic API key patterns', () => {
      const input = 'The service uses api_key: sk-abc123def456ghi789jkl012mno345p';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).not.toContain('sk-abc123');
      expect(redactions).toContain('api_key (1 occurrence)');
    });

    it('redacts API key with equals sign', () => {
      const input = 'export API_TOKEN=abcdef123456789012345678901234567890';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).not.toContain('abcdef123456');
    });

    it('redacts API key in quotes', () => {
      const input = 'config.secret_key = "mySecretKeyValue12345678901234"';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
    });
  });

  describe('AWS keys', () => {
    it('redacts AWS access key IDs', () => {
      const input = 'AWS key: AKIAIOSFODNN7EXAMPLE';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_AWS_KEY]');
      expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redactions).toContain('aws_key (1 occurrence)');
    });

    it('redacts ASIA temporary keys', () => {
      const input = 'temp key ASIAJEXAMPLEKEYID123';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_AWS_KEY]');
    });
  });

  describe('JWT tokens', () => {
    it('redacts JWT tokens', () => {
      const input = 'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_JWT]');
      expect(sanitized).not.toContain('eyJhbGciOiJ');
      expect(redactions).toContain('jwt (1 occurrence)');
    });
  });

  describe('private keys', () => {
    it('redacts PEM private keys', () => {
      const input = `Found key:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn0ygWyRgJEEGTKvMM78FQHKNSK
-----END RSA PRIVATE KEY-----
in the config`;
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
      expect(sanitized).not.toContain('MIIEowIBAAK');
      expect(redactions).toContain('private_key (1 occurrence)');
    });

    it('redacts EC private keys', () => {
      const input = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBkg9oGC\n-----END EC PRIVATE KEY-----';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
    });
  });

  describe('passwords', () => {
    it('redacts password fields', () => {
      const input = 'Database password: SuperSecret123!';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
      expect(sanitized).not.toContain('SuperSecret123');
      expect(redactions).toContain('password (1 occurrence)');
    });

    it('redacts passwd and pwd variants', () => {
      const input1 = 'passwd=mypass1234';
      const input2 = 'pwd: admin5678';
      expect(filterSensitiveContent(input1).sanitized).toContain('[REDACTED_PASSWORD]');
      expect(filterSensitiveContent(input2).sanitized).toContain('[REDACTED_PASSWORD]');
    });
  });

  describe('connection strings', () => {
    it('redacts MongoDB connection strings', () => {
      const input = 'Use mongodb://admin:password123@cluster.example.com:27017/db';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_CONN_STRING]');
      expect(sanitized).not.toContain('admin:password123');
      expect(redactions).toContain('connection_string (1 occurrence)');
    });

    it('redacts PostgreSQL connection strings', () => {
      const input = 'postgresql://user:pass@db.host.com:5432/mydb';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_CONN_STRING]');
    });

    it('redacts Redis connection strings', () => {
      const input = 'redis://default:mytoken@redis-12345.c1.us-east-1.ec2.cloud.redislabs.com:12345';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_CONN_STRING]');
    });
  });

  describe('bearer tokens', () => {
    it('redacts bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCabcdef1234567890';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('Bearer [REDACTED_TOKEN]');
      expect(redactions.some(r => r.includes('bearer_token') || r.includes('jwt'))).toBe(true);
    });
  });

  describe('GitHub tokens', () => {
    it('redacts GitHub personal access tokens', () => {
      const input = 'ghp_ABCDEFghijklmnopqrstuvwxyz0123456789ab';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(redactions).toContain('github_token (1 occurrence)');
    });

    it('redacts GitHub OAuth tokens', () => {
      const input = 'gho_ABCDEFghijklmnopqrstuvwxyz0123456789ab';
      const { sanitized } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
    });
  });

  describe('Slack tokens', () => {
    it('redacts Slack bot tokens', () => {
      const input = 'SLACK_TOKEN=xoxb-0000000FAKE-0000000FAKE0-FaKeSlAcKtOkEnVaLuEhErE';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_SLACK_TOKEN]');
      expect(redactions).toContain('slack_token (1 occurrence)');
    });
  });

  describe('Discord tokens', () => {
    it('redacts Discord bot tokens', () => {
      const input = 'NFAKEFAKEFAKEFAKEFAKEFAKE.XXXXXX.FakeDiscordTokenValueHere0000';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_DISCORD_TOKEN]');
      expect(redactions).toContain('discord_token (1 occurrence)');
    });
  });

  describe('multiple sensitive values', () => {
    it('redacts multiple different types in one text', () => {
      const input = [
        'Config:',
        'password: MySecret123',
        'api_key: abcdef1234567890abcdef1234567890',
        'db: mongodb://admin:pass@host:27017/db',
      ].join('\n');

      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('[REDACTED_CONN_STRING]');
      expect(redactions.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('safe content passes through', () => {
    it('does not redact normal text', () => {
      const input = 'The project uses React and TypeScript. Version 2.0 launched in March.';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toBe(input);
      expect(redactions).toHaveLength(0);
    });

    it('does not redact short strings that happen to match key-like patterns', () => {
      const input = 'Use api for data access. The password field is required.';
      const { sanitized, redactions } = filterSensitiveContent(input);
      // "password field" doesn't match because "field" is not the password value pattern
      // "api for" doesn't match because no key=value pattern
      expect(redactions).toHaveLength(0);
      expect(sanitized).toBe(input);
    });

    it('does not redact mentions of passwords without values', () => {
      const input = 'The user forgot their password and needs to reset it.';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(redactions).toHaveLength(0);
      expect(sanitized).toBe(input);
    });
  });

  describe('wallet keys', () => {
    it('redacts crypto private keys', () => {
      const input = 'private_key: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
      const { sanitized, redactions } = filterSensitiveContent(input);
      expect(sanitized).toContain('[REDACTED_WALLET_KEY]');
      expect(redactions).toContain('wallet_key (1 occurrence)');
    });
  });
});
