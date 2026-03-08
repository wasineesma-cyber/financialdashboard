/**
 * In-memory order store (v1 single-user).
 * Wraps MT5 position data with additional metadata (status, audit trail).
 * On server restart, positions are re-synced from MT5.
 */

const orders = new Map(); // ticket (string) -> order object

export function upsertOrder(ticket, data) {
  const existing = orders.get(String(ticket)) || {};
  orders.set(String(ticket), { ...existing, ...data, ticket: String(ticket) });
}

export function getOrder(ticket) {
  return orders.get(String(ticket)) || null;
}

export function getAllOrders() {
  return Array.from(orders.values());
}

export function removeOrder(ticket) {
  orders.delete(String(ticket));
}

export function clearOrders() {
  orders.clear();
}
