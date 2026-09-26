function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { clampInt, delay };
