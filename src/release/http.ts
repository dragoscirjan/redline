/** Bound metadata and asset responses before retaining remote bytes. */
export async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body !== null) for await (const part of response.body) {
    size += part.length; if (size > limit) throw new Error('Release response exceeds limit'); chunks.push(part);
  }
  return Buffer.concat(chunks);
}
