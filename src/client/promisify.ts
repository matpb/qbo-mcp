// Promisify helper for node-quickbooks callbacks
//
// node-quickbooks surfaces errors in two shapes:
//   1. 2xx response with body.Fault.Error[] — callback gets the body as the error
//   2. non-2xx — callback gets the axios error; Fault body is at err.response.data
// The raw error message from axios is "Request failed with status code 400" which
// tells the user nothing. We extract Intuit's Fault.Error[].Message so the LLM
// (and the user) can see what QBO actually rejected.

interface IntuitFaultError {
  Message?: string;
  Detail?: string;
  code?: string | number;
  element?: string;
}

interface IntuitFaultBody {
  Fault?: { Error?: IntuitFaultError[]; type?: string };
}

function extractIntuitFault(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  // Case 1: err IS the Fault body
  const asBody = err as IntuitFaultBody;
  if (asBody.Fault?.Error?.length) {
    return formatFault(asBody.Fault.Error, asBody.Fault.type);
  }

  // Case 2: axios error with nested response.data.Fault
  const asAxios = err as { response?: { data?: IntuitFaultBody; status?: number } };
  const faultBody = asAxios.response?.data?.Fault;
  if (faultBody?.Error?.length) {
    return formatFault(faultBody.Error, faultBody.type);
  }

  return null;
}

function formatFault(errors: IntuitFaultError[], type?: string): string {
  const parts = errors.map((e) => {
    const bits: string[] = [];
    if (e.code != null) bits.push(`[${e.code}]`);
    if (e.Message) bits.push(e.Message);
    if (e.Detail && e.Detail !== e.Message) bits.push(`(${e.Detail})`);
    if (e.element) bits.push(`(field: ${e.element})`);
    return bits.join(" ");
  });
  const prefix = type ? `Intuit ${type}` : "Intuit";
  return `${prefix}: ${parts.join("; ")}`;
}

export function promisify<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) {
        const intuitMessage = extractIntuitFault(err);
        if (intuitMessage) {
          reject(new Error(intuitMessage));
          return;
        }
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(result);
    });
  });
}
