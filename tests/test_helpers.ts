import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

export function mockFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected fetch call");
    }
    return new Response(
      typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      {
        status: next.status ?? 200,
        headers: next.headers
      }
    );
  });
  return fetchMock;
}
