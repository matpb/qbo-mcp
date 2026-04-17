// URL generation utilities for QuickBooks Online

const TXN_URL_MAP: Record<string, string> = {
  journalentry: "journal",
  purchase: "expense",
  deposit: "deposit",
  salesreceipt: "salesreceipt",
  bill: "bill",
  invoice: "invoice",
  payment: "payment",
};

// Name entities use nameId= instead of txnId=
const NAME_URL_MAP: Record<string, string> = {
  customer: "customerdetail",
};

export function getQboUrl(entityType: string, id: string): string | null {
  const key = entityType.toLowerCase();
  const txnPath = TXN_URL_MAP[key];
  if (txnPath) return `https://app.qbo.intuit.com/app/${txnPath}?txnId=${id}`;
  const namePath = NAME_URL_MAP[key];
  if (namePath) return `https://app.qbo.intuit.com/app/${namePath}?nameId=${id}`;
  return null;
}
