# Hacker News demo

A small Node script that uses Firecrawl to scrape, structure, batch-scrape
and crawl [Hacker News](https://news.ycombinator.com). Steps 1–4 need no LLM.

| Step | Firecrawl feature | What it does |
|---|---|---|
| 1 | `scrape` | Front page as Markdown, links and CSS-selector `attributes` |
| 2 | (client side) | Joins story IDs/URLs from `attributes` with titles from the Markdown |
| 3 | `batchScrape` | Scrapes the top N discussion threads in parallel; pulls points, author and comment count |
| 4 | `crawl` | Starts at `/news` and follows the "More" links through 4 pages (120 stories) |
| 5 | `json` format (`--llm`) | Schema-based LLM extraction; needs an LLM key on the server |

## Run it

```bash
npm install

# Hosted API
FIRECRAWL_API_KEY=fc-... npm start

# Self-hosted (see ../../SELF_HOST.md)
FIRECRAWL_API_URL=http://localhost:3002 npm start

# Options
TOP_N=10 npm start          # how many threads to batch-scrape (default 5)
node demo.mjs --llm         # also run the LLM extraction step
```

Output goes to `out/`:

- `report.md`: table of front-page stories with points and comment counts
- `stories.json`: all 30 front-page stories (rank, id, title, url, discussion)
- `frontpage.md`, `thread-<id>.md`: the raw Markdown Firecrawl returned

## Sample output

```
[1] Scrape the front page
  title:    Hacker News
  status:   200 in 0.7s
  markdown: 18060 chars
  links:    198

[2] Top 5 stories
   1. PipePipe: NewPipe hard fork implementing SponsorBlock
      https://github.com/InfinityLoop1308/PipePipe
   2. Show HN: Reladraw – A diagram language where you decide where to place things
      https://github.com/reladraw/reladraw
   ...

[3] Batch-scrape 5 discussion threads
  completed: 5/5 pages in 10.9s
   250 pts  132 comments  PipePipe: NewPipe hard fork implementing SponsorBlock  (by Qision)
    93 pts   26 comments  Show HN: Reladraw – A diagram language where you decide where to place things  (by jpwalsh234)
   ...

[4] Crawl the first 4 pages of HN
  completed: 4 pages in 15.0s
    https://news.ycombinator.com/news  (30 stories)
    https://news.ycombinator.com/news?p=2  (30 stories)
    https://news.ycombinator.com/news?p=3  (30 stories)
    https://news.ycombinator.com/news?p=4  (30 stories)
  120 stories across the crawl
```

## Compared with Playwright

With Playwright you would launch a browser, write selectors for every field,
convert HTML to text yourself, and write your own crawl queue and concurrency.
Here every page comes back as clean Markdown, `attributes` handles the
selector work, and `batchScrape`/`crawl` run on Firecrawl's workers.
