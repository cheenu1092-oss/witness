/**
 * TemplateEngine — Simple Mustache-style template rendering for vault files.
 *
 * Supports:
 * - {{variable}} — simple substitution
 * - {{#array}}...{{.}}...{{/array}} — array iteration
 * - Unfilled blocks and variables are removed
 *
 * Templates are loaded from the vault's templates/ folder.
 * If a template doesn't exist on disk, built-in defaults are used.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// === Built-in templates ===

const BUILTIN_TEMPLATES: Record<string, string> = {
  person: `---
type: person
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - person
aliases: []
trust_tier: 1
relation: mentioned
---
# {{name}}

## Key Facts
{{#facts}}
- {{.}}
{{/facts}}

## Connections
{{#connections}}
- {{.}}
{{/connections}}

## Interactions
- {{date}}: First mentioned in conversation
`,

  project: `---
type: project
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - project
status: active
priority: medium
---
# {{name}}

## Overview
{{description}}

## Key Facts
{{#facts}}
- {{.}}
{{/facts}}

## Related
{{#connections}}
- {{.}}
{{/connections}}
`,

  concept: `---
type: concept
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - concept
related: []
---
# {{name}}

## Overview
{{description}}

## Key Points
{{#facts}}
- {{.}}
{{/facts}}

## Related Concepts
{{#connections}}
- {{.}}
{{/connections}}
`,

  decision: `---
type: decision
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - decision
decided_by: "{{decided_by}}"
status: final
context: "{{context}}"
---
# {{name}}

**Date:** {{date}}
**Decision:** {{summary}}

## Context
{{body}}

## Alternatives Considered
{{#alternatives}}
- {{.}}
{{/alternatives}}

## Consequences
{{#consequences}}
- {{.}}
{{/consequences}}
`,

  daily: `---
type: daily
date: {{date}}
tags:
  - daily
---
# {{date}}

`,

  topic: `---
type: topic
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - topic
---
# {{name}}

## Overview
{{description}}

## Key Points
{{#facts}}
- {{.}}
{{/facts}}

## Related
{{#connections}}
- {{.}}
{{/connections}}
`,

  org: `---
type: org
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - org
---
# {{name}}

## Overview
{{description}}

## Key Facts
{{#facts}}
- {{.}}
{{/facts}}

## People
{{#connections}}
- {{.}}
{{/connections}}
`,

  place: `---
type: place
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - place
---
# {{name}}

## Key Facts
{{#facts}}
- {{.}}
{{/facts}}
`,
};

/**
 * Render a template with Mustache-style variable substitution.
 *
 * Supports:
 * - {{variable}} → simple value replacement
 * - {{#array}}...{{.}}...{{/array}} → iterate array items
 * - Unfilled blocks/variables are removed cleanly
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let result = template;

  // Handle array blocks: {{#key}}...{{.}}...{{/key}}
  for (const [key, value] of Object.entries(vars)) {
    if (Array.isArray(value)) {
      const blockRegex = new RegExp(`{{#${key}}}([\\s\\S]*?){{/${key}}}`, 'g');
      result = result.replace(blockRegex, (_, inner: string) =>
        value.map(item => inner.replace(/\{\{\.\}\}/g, String(item))).join('\n'),
      );
    }
  }

  // Handle simple variables: {{key}}
  for (const [key, value] of Object.entries(vars)) {
    if (!Array.isArray(value)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''));
    }
  }

  // Remove unfilled array blocks
  result = result.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '');

  // Remove unfilled variables
  result = result.replace(/\{\{\w+\}\}/g, '');

  return result;
}

/**
 * Template engine that loads from disk (vault templates/) with built-in fallbacks.
 */
export class TemplateEngine {
  private templates: Map<string, string> = new Map();

  constructor() {
    // Load built-in templates as defaults
    for (const [name, content] of Object.entries(BUILTIN_TEMPLATES)) {
      this.templates.set(name, content);
    }
  }

  /**
   * Load templates from a directory, overriding built-in defaults.
   * Files are named by template type (e.g., person.md → "person" template).
   */
  loadFromDir(dir: string): void {
    if (!existsSync(dir)) return;

    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = basename(file, extname(file));
      const content = readFileSync(join(dir, file), 'utf-8');
      this.templates.set(name, content);
    }
  }

  /**
   * Render a named template with variables.
   * Falls back to built-in if not found on disk.
   * Returns empty string if template name is completely unknown.
   */
  render(name: string, vars: Record<string, unknown>): string {
    const template = this.templates.get(name);
    if (!template) return '';
    return renderTemplate(template, vars);
  }

  /** List available template names. */
  list(): string[] {
    return [...this.templates.keys()];
  }

  /** Check if a template exists. */
  has(name: string): boolean {
    return this.templates.has(name);
  }
}
