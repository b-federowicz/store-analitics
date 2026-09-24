// Reads a newline-delimited JSON response body (as produced by the
// streaming API routes) and invokes onEvent for each parsed line.
export async function readNdjsonStream<T>(
  res: Response,
  onEvent: (event: T) => void
): Promise<void> {
  if (!res.body) {
    throw new Error("Response has no body to stream.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as T);
    }
  }
}
