// Handler for get_company_info tool

import QuickBooks from "node-quickbooks";
import { promisify, getCompanyIdValue } from "../../client/index.js";

export async function handleGetCompanyInfo(client: QuickBooks): Promise<{ content: Array<{ type: string; text: string }> }> {
  const companyId = getCompanyIdValue();
  const result = await promisify<unknown>((cb) =>
    client.getCompanyInfo(companyId!, cb)
  );
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
