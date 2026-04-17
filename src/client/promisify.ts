// Promisify helper for node-quickbooks callbacks

export function promisify<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
