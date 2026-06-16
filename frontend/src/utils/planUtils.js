export function calculateFinalPriceFE(planName, invoiceSubtotal) {
  const config = {
    basic:    { percentage: 0.05, minimum: 3000 },
    moderate: { percentage: 0.10, minimum: 8000 },
    premium:  { percentage: 0.15, minimum: 20000 },
  };
  const c = config[planName];
  if (!c) return 0;
  return Math.max(invoiceSubtotal * c.percentage, c.minimum);
}
