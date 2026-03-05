/**
 * ved-trust — Trust tier resolution, risk assessment, and HITL work orders.
 *
 * Exports:
 * - TrustEngine: resolve trust tiers, assess risk, make auto-approve decisions
 * - WorkOrderManager: create, approve, deny, and expire work orders
 */

export { TrustEngine } from './engine.js';
export { WorkOrderManager } from './work-orders.js';
