import { describe, it, expect, vi } from "vitest";
import { EmbeddingsClient } from "./embeddings.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("EmbeddingsClient.embed", () => {
  it("POSTs to /api/embed with {model, input} and returns embeddings[0]", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { model: "nomic-embed-text", embeddings: [[0.1, 0.2, 0.3]] });
    });

    const client = new EmbeddingsClient({ fetchImpl });
    const vector = await client.embed("hello world");

    expect(capturedUrl).toBe("http://127.0.0.1:11434/api/embed");
    expect(capturedBody).toEqual({ model: "nomic-embed-text", input: "hello world" });
    expect(vector).toEqual([0.1, 0.2, 0.3]);
  });

  it("uses custom baseUrl and model when provided", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { embeddings: [[0.5]] });
    });

    const client = new EmbeddingsClient({
      baseUrl: "http://example.com:1234/",
      model: "custom-model",
      fetchImpl,
    });
    await client.embed("x");

    expect(capturedUrl).toBe("http://example.com:1234/api/embed");
    expect(capturedBody).toEqual({ model: "custom-model", input: "x" });
  });

  it("throws a clear Error including status and body text on a non-2xx response", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(500, { error: "model not found" }));
    const client = new EmbeddingsClient({ fetchImpl });

    await expect(client.embed("hello")).rejects.toThrow(/500/);
    await expect(client.embed("hello")).rejects.toThrow(/model not found/);
  });

  it("throws a clear Error on a malformed response body (missing embeddings field)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { model: "x" }));
    const client = new EmbeddingsClient({ fetchImpl });

    await expect(client.embed("hello")).rejects.toThrow(/malformed/i);
  });

  it("throws a clear Error when embeddings[0] is missing/empty rather than returning a garbage vector", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { embeddings: [] }));
    const client = new EmbeddingsClient({ fetchImpl });

    await expect(client.embed("hello")).rejects.toThrow(/malformed/i);
  });

  it("throws a clear Error when the response body is not valid JSON", async () => {
    const fetchImpl = mockFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "not json{{{",
        }) as unknown as Response,
    );
    const client = new EmbeddingsClient({ fetchImpl });

    await expect(client.embed("hello")).rejects.toThrow(/JSON/i);
  });
});
