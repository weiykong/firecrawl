/**
 * Hacker News demo for Firecrawl.
 *
 * Shows four Firecrawl features against https://news.ycombinator.com:
 *   1. scrape       – front page as clean Markdown + links + CSS-selector attributes
 *   2. structuring  – turn that into a typed list of top stories (no LLM needed)
 *   3. batchScrape  – fetch the discussion threads of the top stories in parallel
 *   4. crawl        – follow the "More" links through the first pages of HN
 *   5. json (opt.)  – LLM extraction with a schema, if the server has an LLM key
 *
 * Works against the hosted API (set FIRECRAWL_API_KEY) or a self-hosted
 * instance (set FIRECRAWL_API_URL, e.g. http://localhost:3002).
 *
 *   node demo.mjs            # run steps 1-4
 *   node demo.mjs --llm      # also run step 5
 */
import { Firecrawl } from "firecrawl";
import { mkdir, writeFile } from "node:fs/promises";

const HN = "https://news.ycombinator.com/";
const TOP_N = Number(process.env.TOP_N ?? 5);
const OUT = new URL("./out/", import.meta.url);

const firecrawl = new Firecrawl({
  apiKey: process.env.FIRECRAWL_API_KEY ?? "fc-local",
  apiUrl: process.env.FIRECRAWL_API_URL,
});

const step = (n, title) => console.log(`\n\x1b[1m[${n}] ${title}\x1b[0m`);
const timed = async (fn) => {
  const t = Date.now();
  const result = await fn();
  return [result, ((Date.now() - t) / 1000).toFixed(1)];
};

async function main() {
  await mkdir(OUT, { recursive: true });

  // 1. Scrape the front page. `attributes` pulls values out of the HTML with
  //    CSS selectors, so we get stable story IDs and URLs without an LLM.
  step(1, "Scrape the front page");
  const [page, scrapeSecs] = await timed(() =>
    firecrawl.scrape(HN, {
      formats: [
        "markdown",
        "links",
        {
          type: "attributes",
          selectors: [
            { selector: "tr.athing", attribute: "id" },
            { selector: ".titleline > a", attribute: "href" },
          ],
        },
      ],
      onlyMainContent: false,
      maxAge: 0,
    }),
  );
  console.log(`  title:    ${page.metadata?.title}`);
  console.log(`  status:   ${page.metadata?.statusCode} in ${scrapeSecs}s`);
  console.log(`  markdown: ${page.markdown?.length ?? 0} chars`);
  console.log(`  links:    ${page.links?.length ?? 0}`);
  await writeFile(new URL("frontpage.md", OUT), page.markdown ?? "");

  // 2. Join the selector output with the Markdown to get titles.
  step(2, `Top ${TOP_N} stories`);
  const attr = (sel) =>
    page.attributes?.find((a) => a.selector === sel)?.values ?? [];
  const ids = attr("tr.athing");
  const hrefs = attr(".titleline > a");
  const stories = ids.map((id, i) => {
    const href = hrefs[i] ?? "";
    const url = new URL(href, HN).toString();
    return {
      rank: i + 1,
      id,
      title: titleFromMarkdown(page.markdown ?? "", href, url) ?? "(untitled)",
      url,
      discussion: `${HN}item?id=${id}`,
    };
  });
  for (const s of stories.slice(0, TOP_N)) {
    console.log(`  ${String(s.rank).padStart(2)}. ${s.title}`);
    console.log(`      ${s.url}`);
  }
  await writeFile(
    new URL("stories.json", OUT),
    JSON.stringify(stories, null, 2),
  );
  console.log(`  (${stories.length} stories saved to out/stories.json)`);

  // 3. Batch-scrape the discussion threads of the top stories.
  step(3, `Batch-scrape ${TOP_N} discussion threads`);
  const top = stories.slice(0, TOP_N);
  const [batch, batchSecs] = await timed(() =>
    firecrawl.batchScrape(
      top.map((s) => s.discussion),
      { options: { formats: ["markdown"], maxAge: 0 } },
    ),
  );
  console.log(
    `  ${batch.status}: ${batch.completed}/${batch.total} pages in ${batchSecs}s`,
  );
  const threads = batch.data
    .map((doc) => {
      const url = doc.metadata?.sourceURL ?? doc.metadata?.url ?? "";
      const story = top.find((s) => url.endsWith(`id=${s.id}`));
      const md = doc.markdown ?? "";
      const byline = md.match(/(\d+) points? by \[([^\]]+)\]/);
      // Every comment has its own upvote link pointing back at the story.
      const voteIds = [...md.matchAll(/vote\?id=(\d+)&how=up/g)].map((m) => m[1]);
      const comments = new Set(voteIds.filter((id) => id !== story?.id)).size;
      return {
        story,
        points: byline ? Number(byline[1]) : null,
        author: byline?.[2] ?? null,
        comments,
        markdown: md,
      };
    })
    .sort((a, b) => (a.story?.rank ?? 99) - (b.story?.rank ?? 99));
  for (const t of threads) {
    console.log(
      `  ${String(t.points ?? "-").padStart(4)} pts ${String(t.comments).padStart(4)} comments  ${t.story?.title}  (by ${t.author ?? "?"})`,
    );
    if (t.story) {
      await writeFile(new URL(`thread-${t.story.id}.md`, OUT), t.markdown);
    }
  }

  // 4. Crawl: start at /news and let Firecrawl follow the "More" links.
  //    includePaths keeps it on the listing pages instead of wandering off.
  step(4, "Crawl the first 4 pages of HN");
  const [crawl, crawlSecs] = await timed(() =>
    firecrawl.crawl(`${HN}news`, {
      limit: 4,
      includePaths: ["^/news$"],
      scrapeOptions: {
        formats: [
          {
            type: "attributes",
            selectors: [{ selector: "tr.athing", attribute: "id" }],
          },
        ],
        maxAge: 0,
      },
    }),
  );
  const pages = crawl.data
    .map((doc) => ({
      url: doc.metadata?.sourceURL ?? doc.metadata?.url ?? "",
      stories: doc.attributes?.[0]?.values.length ?? 0,
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
  console.log(`  ${crawl.status}: ${crawl.completed} pages in ${crawlSecs}s`);
  for (const p of pages) console.log(`    ${p.url}  (${p.stories} stories)`);
  console.log(
    `  ${pages.reduce((n, p) => n + p.stories, 0)} stories across the crawl`,
  );

  // 5. Optional: schema-based LLM extraction (needs an LLM on the server).
  if (process.argv.includes("--llm")) {
    step(5, "LLM extraction with a JSON schema");
    const res = await firecrawl.scrape(HN, {
      formats: [
        {
          type: "json",
          schema: {
            type: "object",
            properties: {
              stories: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    points: { type: "number" },
                    author: { type: "string" },
                    comments: { type: "number" },
                  },
                  required: ["title"],
                },
              },
            },
          },
        },
      ],
    });
    const extracted = res.json?.stories ?? [];
    console.table(extracted.slice(0, TOP_N));
  }

  await writeFile(new URL("report.md", OUT), report(stories, threads, pages));
  console.log("\nDone. Output written to out/ (report.md, stories.json, ...)");
}

// HN Markdown renders each story as "[Title](url)"; find the one for `href`.
function titleFromMarkdown(md, ...candidates) {
  for (const c of candidates) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = md.match(new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`));
    if (m) return m[1];
  }
  return null;
}

function report(stories, threads, pages) {
  const lines = [
    `# Hacker News snapshot`,
    ``,
    `Scraped ${new Date().toISOString()} with Firecrawl.`,
    ``,
    `## Front page`,
    ``,
    `| # | Story | Points | Comments |`,
    `|---|---|---|---|`,
  ];
  for (const s of stories) {
    const t = threads.find((x) => x.story?.id === s.id);
    lines.push(
      `| ${s.rank} | [${s.title.replace(/\|/g, "\\|")}](${s.url}) | ${t?.points ?? ""} | ${t ? `[${t.comments}](${s.discussion})` : ""} |`,
    );
  }
  lines.push(``, `## Crawled pages`, ``);
  for (const p of pages) lines.push(`- ${p.url} (${p.stories} stories)`);
  return lines.join("\n") + "\n";
}

main().catch((err) => {
  console.error(err?.details ?? err);
  process.exit(1);
});
