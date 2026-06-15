export class GitHubApi {
  constructor(private readonly token?: string) {}

  async getJson<T>(path: string, accept = "application/vnd.github+json"): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: this.headers(accept)
    });
    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async getText(path: string, accept: string): Promise<string> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: this.headers(accept)
    });
    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}: ${await response.text()}`);
    }
    return response.text();
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method: "POST",
      headers: {
        ...this.headers("application/vnd.github+json"),
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async paginate<T>(path: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = `https://api.github.com${path}`;
    while (next) {
      const response = await fetch(next, { headers: this.headers("application/vnd.github+json") });
      if (!response.ok) {
        throw new Error(`GitHub API HTTP ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as Record<string, T[]>;
      items.push(...(body[key] ?? []));
      next = parseNextLink(response.headers.get("link"));
    }
    return items;
  }

  private headers(accept: string): HeadersInit {
    return {
      accept,
      authorization: this.token ? `Bearer ${this.token}` : "",
      "x-github-api-version": "2022-11-28"
    };
  }
}

function parseNextLink(link: string | null): string | undefined {
  if (!link) {
    return undefined;
  }
  const next = link.split(",").find((part) => part.includes('rel="next"'));
  return next?.match(/<([^>]+)>/)?.[1];
}
