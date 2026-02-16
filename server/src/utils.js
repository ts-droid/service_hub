const DEFAULT_ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'vendora.se';

const GROUPS = ["SUPPORT", "RMA", "FINANCE", "LOGISTICS", "MARKETING", "SALES"]; 

function makeId(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function normalizeEmails(raw) {
  if (!raw) return [];
  const matches = String(raw).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return matches.map(e => e.toLowerCase());
}

function isInternal(from) {
  return normalizeEmails(from).some(e => e.endsWith(`@${DEFAULT_ALLOWED_DOMAIN}`));
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  DEFAULT_ALLOWED_DOMAIN,
  GROUPS,
  makeId,
  normalizeEmails,
  isInternal,
  nowIso
};
