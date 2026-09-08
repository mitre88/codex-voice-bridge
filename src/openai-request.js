// Injectable main-process HTTP boundary. Never logs keys, headers or payloads.
export async function postOpenAIJson({
  apiKey,
  url,
  body,
  safetyId,
  timeoutMs = 60000,
  signal,
  fetch = globalThis.fetch,
}) {
  if (signal?.aborted) throw new Error("Session cancelled.");
  if (!/^https:\/\/api\.openai\.com\/v1\/realtime\/(?:translations\/)?client_secrets$/.test(url))
    throw new Error("Unexpected token endpoint.");
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Session cancelled.");
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      throw new Error(`OpenAI request timed out after ${timeoutMs / 1000}s.`);
    throw error;
  }
}
