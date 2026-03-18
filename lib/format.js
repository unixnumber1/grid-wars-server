// ── Number formatting utilities ──

export function formatNumber(num) {
  if (num == null) return '0';
  if (num >= 1e15) return (num / 1e15).toFixed(1) + 'Q';
  if (num >= 1e12) return (num / 1e12).toFixed(1) + 'T';
  if (num >= 1e9)  return (num / 1e9).toFixed(1)  + 'B';
  if (num >= 1e6)  return (num / 1e6).toFixed(1)  + 'M';
  if (num >= 1e3)  return (num / 1e3).toFixed(1)  + 'K';
  return String(Math.floor(num));
}

export function formatCoins(coins) {
  return formatNumber(coins);
}
