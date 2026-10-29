# Washington Code — RCW statutes, WAC agency rules, and bill tracking

Washington state law and legislative activity from the Legislature's own
sources, keyless: the **Revised Code of Washington** (RCW, statutes) by
citation, the **Washington Administrative Code** (WAC, agency rules) by
citation, by topic, by structure, by year-end archive, and by rule-making
history, and **legislative bills** — status, amendments and floor votes — by
bill number and biennium.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | What it answers |
|---|---|
| `wa_rcw_section({section: "9A.32.030"})` | Full text and heading of an RCW statute. |
| `wa_wac_section({section: "296-800-110"})` | CURRENT text of a WAC rule: caption, body, the statutory-authority history line, and the RCW sections the agency cited as authority. |
| `wa_wac_search({query: "safety bulletin board", limit?, cite_prefix?})` | FULL-TEXT search across every WAC section via the Legislature's own site-search index; returns citations, captions, highlighted snippets and the index-wide match count. `cite_prefix` ("296" or "296-800") restricts to a title or chapter. |
| `wa_wac_browse({cite?})` | Structure: no cite → every WAC title with its agency; a title ("296") → its chapters; a chapter ("296-800") → its sections with captions and subheadings. |
| `wa_wac_archived_section({section, year})` | Text of a WAC rule AS IT STOOD at the end of a past year (full text 2019 onward; PDF-only 2004–2018, see below). |
| `wa_wac_filings({cite})` | Every Washington State Register (WSR) rule-making filing that touched a section or chapter — number, type, date filed, link — newest first. |
| `wa_bill_status({bill: "HB 1002", biennium?})` | Current status, description, legal title, sponsor list, introduced date and companion bills for a legislative bill. |
| `wa_bill_amendments({bill, biennium?})` | Every amendment proposed to a bill — sponsor, floor action (ADOPTED/FAILED/WITHDRAWN), date, text links — most recent first. |
| `wa_bill_votes({bill, biennium?})` | Recorded floor roll-call votes on a bill — motion, chamber, date, yea/nay/absent/excused counts and the voting legislators. |
| `wa_session_bills({biennium?, status?, agency?, limit?, offset?})` | Bills for a biennium filtered by procedural status (introduced, passed_house/senate/legislature, signed/vetoed/partial_veto by the Governor), with aggregate counts first. |

Citations accept the `RCW`/`WAC` prefix, letter-suffixed titles and chapters
(`296-14A-100`, `132C-120-010`), and typographic dashes. Bill numbers accept
any chamber/version prefix (`HB 1000`, `SHB 1000`, `2SHB 1000`, bare `1000`).
Every response carries `data_as_of`, `source` and (for RCW/WAC) the exact
upstream `url`.

## The four capabilities, and which one is only partly there

| Capability | WAC | How |
|---|---|---|
| Section by citation | yes | `wa_wac_section`, live fetch of `app.leg.wa.gov/WAC/default.aspx?cite=…`. |
| Topic search | yes, full text | `wa_wac_search` calls the SearchUnify index behind `leg.wa.gov/search`, restricted to the WAC source. This matches rule TEXT, not just captions. |
| Historical version | yes for 2019 onward; link-only before | `wa_wac_archived_section` reads the Legislature's year-end HTML archive. 2004–2018 were published as PDF only: the tool returns the chapter PDF link for 2016–2018 and the archive directory for earlier years, as `found:false, reason:"pdf_only_year"` — never a guess at the text. |
| Amendments / history | yes | `wa_wac_section.history` (the `[Statutory Authority: … WSR …]` line, with `authority_rcw` parsed out) and `wa_wac_filings` (the WSR filing list, including pending proposals and emergency rules). |

## Miss signals — positive, not inferred

- **RCW:** a bad citation renders a panel with the id `pnlCitationNotFound`
  (HTTP 200). The pack keys on that panel.
- **WAC:** a nonexistent section answers an **HTTP 302** to the chapter's
  dispositions page (`?dispo=true&cite=296-800`). The pack fetches with
  `redirect: 'manual'` and reads the miss from the status line, returning
  `found:false, reason:"section_not_found"` with the dispositions link.
- **Anything else that is not a 200 throws a loud error naming the upstream
  status.** A transport failure is never reshaped into `found:false`
  (`src/index.test.ts` pins this — the oklahoma-code lesson, fleet #2742).
- **Bills:** a nonexistent bill number/biennium combination answers **HTTP
  200 with an empty array** — there is no 404 or error panel for this case.
  `wa_bill_status` reads zero records as `found:false, reason:"bill_not_found"`.
  `wa_bill_amendments` and `wa_bill_votes` read an empty list as a normal
  zero-result answer (a bill can genuinely have no amendments or no recorded
  roll call), not a miss — the note says so and points at `wa_bill_status` to
  confirm the bill itself exists.

## Bill tracking (added fleet #3240)

Reads directly from the Washington State Legislature's own bill-tracking web
service — not a third-party aggregator (LegiScan/OpenStates already cover all
50 states generically; this is the Legislature's own free data for Washington
specifically). Bills are addressed by **(biennium, bill number)**: Washington
runs a two-year biennium starting on an odd year (`"2025-26"`), and bill
numbers are reassigned each biennium, so the same number is a different bill
two years later. All four tools default to the current biennium when omitted.

`wa_session_bills`'s `status` filter and what each needs:

| status | agency required? | What it lists |
|---|---|---|
| `introduced` (default) | no | Every bill filed in the biennium (merges the Legislature's per-calendar-year listing across the two years). |
| `passed_house` / `passed_senate` / `passed_legislature` | no | Bills that passed that chamber / both chambers. |
| `signed` / `vetoed` / `partial_veto` | yes (`House` or `Senate` — chamber of **origin**) | Governor's action, by the bill's chamber of origin. |

`wa_session_bills` and the bulk Legislature listings it wraps carry no
description field — only id, type, chamber and active flag. Call
`wa_bill_status` on a specific bill id for its description and current status.

## Archive filenames are fixed-width (measured 2026-10-07)

`lawfilesext.leg.wa.gov/law/wacarchive/<year>/htm/…` names files with
space-padded fields: the numeric title and chapter are right-aligned to 3
characters and padded to 4, the section is appended as typed:

```
296-800-110  →  WAC 296 -800 -110.htm
1-04-010     →  WAC   1 - 04 -010.htm
```

2019–2023 nest the file under `WAC 296  TITLE/WAC 296 -800  CHAPTER/`; 2024
onward is flat under `WAC 296 -800  CHAPTER/`. The resolver tries the likely
layout for the year first and the other second; a 404 at both is
`section_not_in_archive` with the URLs tried, so a one-space error cannot
masquerade as "the rule did not exist that year". The tests pin both layouts.

## The search index is the Legislature's own, read as its client does

`leg.wa.gov/search` is a thin client over a SearchUnify instance. Its host,
client uid and per-client access token are served to every anonymous visitor
inside the client bundle (`an.js`), so they are configuration we read, not a
credential we hold; the pack caches them and re-reads the bundle once if the
API rejects them. Requests identify as `pipeworx-mcp-washington-code` — no
Origin or Referer is sent and none is needed (verified 2026-10-07: identical
results with and without). `cite_prefix` filtering is client-side over the top
50 index hits, and the response says so in `total_matches_note`.

## Edge probe (2026-10-07)

Per the standing rule for any new upstream host, every URL shape the WAC tools
use was fetched from a throwaway `wrangler dev --remote` Worker on the prod
account before deploy. All answered a Cloudflare Worker exactly as they answer
a laptop — no relay needed:

```
app.leg.wa.gov/WAC/default.aspx?cite=296-800-110         200  117,345 B
app.leg.wa.gov/WAC/default.aspx?cite=296-800-99999       302  → /WAC/default.aspx?dispo=true&cite=296-800
app.leg.wa.gov/WAC/                                      200  144,207 B
app.leg.wa.gov/WAC/default.aspx?cite=296-800             200  187,138 B
app.leg.wa.gov/WAC/registerfiling.aspx?cite=296-800-110  200  109,878 B
lawfilesext…/wacarchive/2020/htm/WAC 296  TITLE/…        200   10,076 B
lawfilesext…/wacarchive/2024/htm/WAC 296 -800  CHAPTER/… 200   10,076 B
lh112524p.searchunify.com/search/searchResultByPost      200   11,313 matches for "safety bulletin board"
```

## Smoke (pre-deploy, 2026-10-07)

`smoke.json` holds the arguments; all six tools returned non-empty payloads:
`wa_wac_section 296-800-110` 1,386 chars of text + 4-filing history,
`wa_wac_search "safety bulletin board"` 5 of 11,313, `wa_wac_browse 296-800`
136 sections, `wa_wac_archived_section 296-800-110 @2020` 1,386 chars,
`wa_wac_filings 296-800-110` 4 WSR filings.

## Smoke — bill tracking (pre-deploy, 2026-10-18)

All four bill tools returned non-empty live payloads against the current
(2025-26) biennium: `wa_bill_status({bill:"HB 1002"})` → status "H Rules 3C",
10 sponsors; `wa_bill_amendments({bill:"1002", biennium:"2023-24"})` → 1
amendment, ADOPTED 2023-04-05; `wa_bill_votes({bill:"HB 1002"})` → House 3rd
Reading vote, 70 yea / 24 nay / 4 excused, 2026-02-10;
`wa_session_bills({biennium:"2025-26", status:"passed_legislature"})` → 709
bills (397 House / 312 Senate); `wa_session_bills({..., status:"signed",
agency:"House"})` → 385 bills. The miss case
(`wa_bill_status({bill:"99999", biennium:"2025-26"})`) returned
`found:false, reason:"bill_not_found"` from a genuine empty-array upstream
response, not a guess.

## Caveats

- RCW and WAC numbers are not contiguous; repealed and recodified sections are
  normal. `wa_wac_browse` on the chapter shows what exists today.
- A `cite_prefix` search that returns zero is a real zero under that prefix in
  the top 50 hits, not a failure; the `note` says how many index-wide matches
  there were.

## Data source

Washington State Legislature — `app.leg.wa.gov` (current RCW and WAC, WSR
filings), `lawfilesext.leg.wa.gov` (annual WAC archive), the Legislature's
site-search index, and the Legislature's own legislative bill-tracking data
(status, amendments, sponsors, floor votes). Keyless. Washington statutes,
agency rules and legislative bill records are public record.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "washington-code": {
      "url": "https://gateway.pipeworx.io/washington-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/washington-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/wa_rcw_section \
  -H 'Content-Type: application/json' \
  -d '{"section":"9A.32.030"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/wa_rcw_section`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-washington-code` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/washington-code/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "washington-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-washington-code"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Washington Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
