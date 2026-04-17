// Cents-based integer arithmetic for monetary calculations
// Avoids floating-point precision errors (e.g., 0.1 + 0.2 = 0.30000000000000004)

/**
 * Convert dollars to cents (integer).
 * Rounds to nearest cent to handle floating-point input.
 */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Convert cents back to dollars for display/API.
 */
export function toDollars(cents: number): number {
  return cents / 100;
}

/**
 * Validate that a dollar amount has at most 2 decimal places.
 * Returns the amount in cents if valid, throws if invalid.
 *
 * @param dollars - The dollar amount to validate
 * @param fieldName - Optional field name for error messages
 * @returns The amount in cents (integer)
 * @throws Error if amount has more than 2 decimal places
 */
export function validateAmount(dollars: number, fieldName = 'Amount'): number {
  // Check if the amount has more than 2 decimal places
  // Multiply by 100 and check if it's a whole number
  const cents = dollars * 100;
  const rounded = Math.round(cents);

  // Allow tiny floating-point errors (e.g., 10.00 might be 10.000000000001)
  if (Math.abs(cents - rounded) > 0.001) {
    const decimalPart = String(dollars).split('.')[1];
    const decimalPlaces = decimalPart ? decimalPart.length : 0;
    throw new Error(
      `${fieldName} $${dollars} has ${decimalPlaces} decimal places. ` +
      `QuickBooks only supports 2 decimal places (cents). ` +
      `Did you mean $${(rounded / 100).toFixed(2)}?`
    );
  }

  return rounded;
}

/**
 * Sum an array of cent amounts (integer addition).
 * Guarantees exact precision unlike float addition.
 */
export function sumCents(amounts: number[]): number {
  return amounts.reduce((sum, amt) => sum + amt, 0);
}

/**
 * Validate that debits equal credits exactly.
 * Throws if they don't match.
 *
 * @param debitsCents - Total debits in cents
 * @param creditsCents - Total credits in cents
 * @throws Error if debits don't equal credits
 */
export function validateBalance(debitsCents: number, creditsCents: number): void {
  if (debitsCents !== creditsCents) {
    const debits = toDollars(debitsCents);
    const credits = toDollars(creditsCents);
    const diff = toDollars(Math.abs(debitsCents - creditsCents));
    throw new Error(
      `Debits ($${debits.toFixed(2)}) must equal Credits ($${credits.toFixed(2)}). ` +
      `Difference: $${diff.toFixed(2)}`
    );
  }
}

/**
 * Format cents as a dollar string for display.
 */
export function formatDollars(cents: number): string {
  return toDollars(cents).toFixed(2);
}
