/**
 * Convert amount to smallest currency unit (grosze for PLN)
 * P24 expects amounts in grosze (1 PLN = 100 grosze)
 */
export function getSmallestUnit(amount: number, currencyCode: string): number {
  // P24 primarily supports PLN, but we can handle other currencies too
  const currencyMultipliers: Record<string, number> = {
    PLN: 100, // grosze
    EUR: 100, // cents
    USD: 100, // cents
    GBP: 100, // pence
  };

  const multiplier = currencyMultipliers[currencyCode.toUpperCase()] || 100;
  return Math.round(amount * multiplier);
}

/**
 * Convert amount from smallest currency unit back to major unit
 */
export function getAmountFromSmallestUnit(
  amount: number,
  currencyCode: string
): number {
  const currencyMultipliers: Record<string, number> = {
    PLN: 100,
    EUR: 100,
    USD: 100,
    GBP: 100,
  };

  const multiplier = currencyMultipliers[currencyCode.toUpperCase()] || 100;
  return amount / multiplier;
}
