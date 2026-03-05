import { describe, it, expect } from 'vitest';
import { renderTemplate, TemplateEngine } from './template.js';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'Ved' });
    expect(result).toBe('Hello Ved!');
  });

  it('replaces multiple occurrences of same variable', () => {
    const result = renderTemplate('{{x}} and {{x}}', { x: 'test' });
    expect(result).toBe('test and test');
  });

  it('handles array blocks', () => {
    const template = '{{#items}}- {{.}}\n{{/items}}';
    const result = renderTemplate(template, { items: ['a', 'b', 'c'] });
    expect(result).toContain('- a');
    expect(result).toContain('- b');
    expect(result).toContain('- c');
  });

  it('removes unfilled array blocks', () => {
    const template = 'Before\n{{#items}}- {{.}}\n{{/items}}After';
    const result = renderTemplate(template, {});
    expect(result).toBe('Before\nAfter');
  });

  it('removes unfilled variables', () => {
    const result = renderTemplate('Hello {{name}}!', {});
    expect(result).toBe('Hello !');
  });

  it('handles empty arrays', () => {
    const template = '{{#items}}- {{.}}\n{{/items}}';
    const result = renderTemplate(template, { items: [] });
    expect(result).toBe('');
  });
});

describe('TemplateEngine', () => {
  it('has built-in templates', () => {
    const engine = new TemplateEngine();
    expect(engine.has('person')).toBe(true);
    expect(engine.has('project')).toBe(true);
    expect(engine.has('decision')).toBe(true);
    expect(engine.has('daily')).toBe(true);
    expect(engine.has('concept')).toBe(true);
  });

  it('renders person template', () => {
    const engine = new TemplateEngine();
    const result = engine.render('person', {
      name: 'Bob Friday',
      created: '2026-03-05',
      updated: '2026-03-05',
      source: 'conversation',
      confidence: 'high',
      facts: ['Chief AI Officer at HPE', 'Founded Mist Systems'],
      connections: ['[[hpe]]', '[[mist-systems]]'],
      date: '2026-03-05',
    });
    expect(result).toContain('# Bob Friday');
    expect(result).toContain('Chief AI Officer at HPE');
    expect(result).toContain('[[hpe]]');
    expect(result).toContain('type: person');
  });

  it('renders daily template', () => {
    const engine = new TemplateEngine();
    const result = engine.render('daily', { date: '2026-03-05' });
    expect(result).toContain('# 2026-03-05');
    expect(result).toContain('type: daily');
  });

  it('returns empty for unknown template', () => {
    const engine = new TemplateEngine();
    expect(engine.render('nonexistent', {})).toBe('');
  });

  it('lists all template names', () => {
    const engine = new TemplateEngine();
    const names = engine.list();
    expect(names).toContain('person');
    expect(names).toContain('project');
    expect(names.length).toBeGreaterThanOrEqual(7);
  });
});
