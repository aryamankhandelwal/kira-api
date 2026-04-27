export interface CSEItem {
  link: string;
  displayLink: string; // bare domain, e.g. "www.ajio.com"
  title: string;
}

export async function searchProductItems(
  query: string,
  count = 10
): Promise<CSEItem[]> {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY!,
    cx: process.env.GOOGLE_SEARCH_ENGINE_ID!,
    q: query,
    num: String(Math.min(count, 10)),
  });

  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params}`,
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message ?? `CSE error ${res.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.items ?? []).map((item: any) => ({
    link: item.link,
    displayLink: item.displayLink,
    title: item.title,
  }));
}

export async function searchProducts(
  query: string,
  count = 5
): Promise<string[]> {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY!,
    cx: process.env.GOOGLE_SEARCH_ENGINE_ID!,
    q: query,
    num: String(count),
  });

  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params}`
  );
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message ?? `CSE error ${res.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.items ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((item: any) => item.link)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((link: any): link is string => typeof link === "string");
}
