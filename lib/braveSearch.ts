export interface BraveSearchResult {
  url: string;
  displayUrl: string; // bare domain, e.g. "ajio.com"
  title: string;
  thumbnail: string | null;
}

export async function braveSearch(
  query: string,
  count = 5
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
  });

  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
      signal: AbortSignal.timeout(5000),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.message ?? `Brave Search error ${res.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.web?.results ?? []).map((item: any) => ({
    url: item.url,
    displayUrl: new URL(item.url).hostname.replace(/^www\./, ""),
    title: item.title ?? "",
    thumbnail: item.thumbnail?.src ?? null,
  }));
}
