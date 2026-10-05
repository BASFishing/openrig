// Thin client for Ollama's embeddings HTTP API.
//
// Verified against Ollama's current API docs (docs/api.md in ollama/ollama) as of
// writing: the batch `POST /api/embed` endpoint ({model, input} -> {embeddings:
// number[][]}) is the current, recommended endpoint. The older singular
// `POST /api/embeddings` endpoint ({model, prompt} -> {embedding: number[]}) still
// exists but is documented as superseded/deprecated in favor of /api/embed, which
// supports batching and newer options (truncate, dimensions, keep_alive) and returns
// timing metadata alongside the embeddings. This client uses /api/embed, passing a
// single string as `input` and reading the first (and only) vector out of the
// returned `embeddings` array.

export interface EmbeddingsClientDeps {
  /** Default: http://127.0.0.1:11434 */
  baseUrl?: string;
  /** Default: "nomic-embed-text" */
  model?: string;
  /** Injectable for tests. Default: the global fetch. */
  fetchImpl?: typeof fetch;
}

export class EmbeddingsClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: EmbeddingsClientDeps = {}) {
    this.baseUrl = deps.baseUrl ?? "http://127.0.0.1:11434";
    this.model = deps.model ?? "nomic-embed-text";
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Returns the embedding vector for one piece of text. Throws a clear Error
   *  (include the response status/body text) on a non-2xx response or a malformed
   *  response body (never return a garbage/empty vector silently). */
  async embed(text: string): Promise<number[]> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/api/embed`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new Error(
        `EmbeddingsClient: Ollama /api/embed returned ${response.status} ${response.statusText}: ${bodyText}`,
      );
    }

    let parsed: unknown;
    const rawText = await safeReadText(response);
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error(
        `EmbeddingsClient: failed to parse /api/embed response as JSON: ${String(err)}. Raw body: ${rawText}`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("embeddings" in parsed) ||
      !Array.isArray((parsed as { embeddings: unknown }).embeddings)
    ) {
      throw new Error(
        `EmbeddingsClient: malformed /api/embed response — expected { embeddings: number[][] }, got: ${rawText}`,
      );
    }

    const embeddings = (parsed as { embeddings: unknown[] }).embeddings;
    const vector = embeddings[0];
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number")) {
      throw new Error(
        `EmbeddingsClient: malformed /api/embed response — expected a non-empty number[] at embeddings[0], got: ${rawText}`,
      );
    }

    return vector as number[];
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}
