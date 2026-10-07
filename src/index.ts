interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Washington state law: the Revised Code of Washington (RCW, statutes) and the
 * Washington Administrative Code (WAC, agency rules).
 *
 *   RCW:  app.leg.wa.gov/RCW/default.aspx?cite=9A.32.030
 *   WAC:  app.leg.wa.gov/WAC/default.aspx?cite=296-800-110
 *         app.leg.wa.gov/WAC/registerfiling.aspx?cite=296-800-110   (WSR filings)
 *         lawfilesext.leg.wa.gov/law/wacarchive/<year>/...            (annual archive)
 *         lh112524p.searchunify.com/search/searchResultByPost         (the
 *         Legislature's own full-text search; leg.wa.gov/search is a thin
 *         client over it)
 *
 * Washington is the one state of the four whose RCW miss page says what it is:
 * a nonexistent citation renders a panel with the id
 * `ContentPlaceHolder1_pnlCitationNotFound`. It still answers HTTP 200 — every
 * state source does — but the markup admits the miss instead of leaving it to
 * be inferred, so the detection there keys on that panel directly rather than
 * on the absence of content.
 *
 * The WAC side is different and better: a nonexistent WAC section answers an
 * HTTP 302 to the chapter's dispositions page (`?dispo=true&cite=296-800`),
 * so the miss is read from the status line with `redirect: 'manual'`. A
 * positive miss signal cannot fail the way an absence check does.
 *
 * WAC archive filenames are FIXED-WIDTH (measured 2026-10-07): the title is
 * right-aligned to 3 characters then padded to 4, the chapter the same, and
 * the section is appended as typed — so 296-800-110 is
 * `WAC 296 -800 -110.htm` and 1-04-010 is `WAC   1 - 04 -010.htm`. The tree
 * is nested by title for 2019–2023 and flat by chapter for 2024 onward; the
 * resolver tries both. Years before 2019 are PDF-only.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit, name = 'Washington State Legislature'): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, name);
}

const RCW_BASE = 'https://app.leg.wa.gov/RCW/default.aspx?cite=';
const WAC_BASE = 'https://app.leg.wa.gov/WAC/default.aspx?cite=';
const WAC_HOME = 'https://app.leg.wa.gov/WAC/';
const WAC_FILINGS = 'https://app.leg.wa.gov/WAC/registerfiling.aspx?cite=';
const WAC_ARCHIVE = 'https://lawfilesext.leg.wa.gov/law/wacarchive/';
const UA = 'pipeworx-mcp-washington-code/1.0 (+https://pipeworx.io)';
const NOT_FOUND_PANEL = 'pnlCitationNotFound';

// The Legislature's site search (leg.wa.gov/search) is a SearchUnify client.
// Its instance host, client uid and the public per-client access token are
// served to every anonymous visitor inside the client bundle (an.js), so they
// are configuration we read, not a credential we hold. The token is cached
// here and refreshed from the bundle once if the search API rejects it.
const SU_CLIENT_JS =
  'https://d3k6i4as5v4q0x.cloudfront.net/f42a2cde54e7a32e4c14c23c3832a714/search-clients/0b1bb940-dbe3-11f0-ae0e-0242ac120005/an.js';
let suConfig = {
  search: 'https://lh112524p.searchunify.com',
  uid: '0b1bb940-dbe3-11f0-ae0e-0242ac120005',
  accessToken: '9ad5ad4164aea64521fd3c00a19b76c8',
};

const SOURCE = 'Washington State Legislature (app.leg.wa.gov / lawfilesext.leg.wa.gov), keyless';
const ATTRIBUTION = 'Washington statutes and agency rules are public record.';

function toText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(html: string): string {
  return toText(html).replace(/\s*\n\s*/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// WAC citation parsing
// ---------------------------------------------------------------------------

type WacCite = { title: string; chapter?: string; section?: string };

/** "WAC 296-800-110", "296-800-110", "296‑800‑110", "296.800.110", "296-800", "296". */
function parseWac(raw: unknown): WacCite | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/^WAC\s*/i, '')
    .replace(/[‐-―−]/g, '-') // typographic dashes
    .replace(/\s+/g, '')
    .toUpperCase();
  const m = s.match(/^(\d{1,3}[A-Z]?)(?:[-.](\d{1,3}[A-Z]?)(?:[-.](\d{3,6}[A-Z]?))?)?$/);
  if (!m) return null;
  const out: WacCite = { title: m[1] };
  if (m[2]) out.chapter = m[2];
  if (m[3]) out.section = m[3];
  return out;
}

function citeString(c: WacCite): string {
  return [c.title, c.chapter, c.section].filter(Boolean).join('-');
}

const WAC_FORMAT_HINT =
  'WAC citations are title-chapter-section, e.g. "296-800-110" (safe workplace summary) or "458-20-178" (use tax). A title or chapter alone ("296", "296-800") is for wa_wac_browse.';

// ---------------------------------------------------------------------------
// RCW (unchanged behaviour)
// ---------------------------------------------------------------------------

async function rcwSection(args: Record<string, unknown>): Promise<unknown> {
  const raw = String(args.section ?? '').trim().replace(/\s+/g, '').replace(/^RCW/i, '');
  if (!/^\d+[A-Za-z]?\.\d+[A-Za-z]?\.\d+$/.test(raw)) {
    const wac = parseWac(args.section);
    return {
      found: false,
      reason: 'unparsed_section',
      message: `"${args.section}" is not an RCW citation.`,
      hint:
        wac && wac.section
          ? `"${citeString(wac)}" looks like a WAC (Washington Administrative Code) citation — call wa_wac_section for agency rules. RCW citations are title.chapter.section, e.g. "9A.32.030".`
          : 'RCW citations are title.chapter.section, e.g. "9A.32.030" (murder 1) or "46.61.502" (DUI). For agency rules (WAC, title-chapter-section like 296-800-110) use wa_wac_section.',
    };
  }

  const url = `${RCW_BASE}${encodeURIComponent(raw)}`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Washington Legislature returned HTTP ${res.status} for ${raw}`);
  const html = await res.text();

  // Positive miss signal — the page names its own failure.
  if (html.includes(NOT_FOUND_PANEL)) {
    return {
      found: false,
      reason: 'section_not_found',
      section: raw,
      message: `No RCW ${raw}. The Washington site reports the citation as not found (it still answers HTTP 200, so this is read from the page rather than the status).`,
      hint: 'RCW numbers are not contiguous — repealed and recodified sections are normal.',
    };
  }

  // Start past the panel's closing '>' for the same reason as Ohio: slicing at
  // the id leaves markup fragments leading the statute text.
  const i = html.indexOf('ContentPlaceHolder1_pnlTitleBlock');
  const text = toText(i === -1 ? html : html.slice(html.indexOf('>', i) + 1));
  // The title block reads "PDF RCW 9A.32.030 Murder in the first degree. (1) A
  // person is guilty..." — the heading is what sits between the citation and
  // the first subsection, not simply the first non-trivial line, which is just
  // the citation echoed back.
  const hm = text.match(/RCW\s+[\dA-Za-z.]+\s+([^\n(]{4,140}?)\.\s/);
  const heading = hm ? hm[1].trim() : null;

  return {
    citation: `RCW ${raw}`,
    section: raw,
    heading: heading || null,
    text,
    text_chars: text.length,
    url,
    source: 'Washington State Legislature (app.leg.wa.gov), keyless',
    attribution: 'Washington statutes are public record.',
  };
}

// ---------------------------------------------------------------------------
// WAC: current section text
// ---------------------------------------------------------------------------

/** Split "[Statutory Authority: ... WSR 18-22-116, § 296-800-110, filed 11/6/18 ...]" off the end of a section body. */
function splitHistory(body: string): { text: string; history: string | null; authority_rcw: string[] } {
  const m = body.match(/\[\s*(Statutory Authority[\s\S]*?)\]\s*$/);
  if (!m) return { text: body.trim(), history: null, authority_rcw: [] };
  const history = m[1].replace(/\s+/g, ' ').trim();
  const text = body.slice(0, m.index).trim();
  const authority_rcw = Array.from(new Set(history.match(/\b\d+[A-Z]?\.\d+[A-Z]?\.\d+\b/g) ?? []));
  return { text, history, authority_rcw };
}

function fieldOf(html: string, field: string): string | null {
  const m = html.match(new RegExp(`<!-- field: ${field} -->([\\s\\S]*?)<!-- field: -->`));
  return m ? inline(m[1]) : null;
}

async function wacSection(args: Record<string, unknown>): Promise<unknown> {
  const cite = parseWac(args.section);
  if (!cite) {
    return { found: false, reason: 'unparsed_section', message: `"${args.section}" is not a WAC citation.`, hint: WAC_FORMAT_HINT };
  }
  if (!cite.section) {
    return {
      found: false,
      reason: 'not_a_section',
      citation: `WAC ${citeString(cite)}`,
      message: `"${citeString(cite)}" is a ${cite.chapter ? 'chapter' : 'title'}, not a section. Call wa_wac_browse({cite: "${citeString(cite)}"}) to list what it contains.`,
      hint: WAC_FORMAT_HINT,
    };
  }
  const id = citeString(cite);
  const url = `${WAC_BASE}${encodeURIComponent(id)}`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });

  // Positive miss signal: a nonexistent section is answered with a 302 to the
  // chapter's dispositions page, not a 200 with an apology in the body.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '';
    return {
      found: false,
      reason: 'section_not_found',
      section: id,
      message: `No current WAC ${id}. The Washington site redirects the citation to the chapter dispositions page instead of serving a section (HTTP ${res.status} → ${location || 'no Location'}).`,
      hint: `WAC numbers are not contiguous — repealed and recodified sections are normal. wa_wac_browse({cite: "${cite.title}-${cite.chapter}"}) lists the sections that do exist; wa_wac_archived_section can retrieve a repealed section from an earlier year's archive.`,
      dispositions_url: location ? new URL(location, WAC_BASE).toString() : null,
    };
  }
  if (!res.ok) throw new Error(`Washington Legislature returned HTTP ${res.status} for WAC ${id}`);
  const html = await res.text();

  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/);
  const h2 = html.match(/<h2>([\s\S]*?)<\/h2>/);
  const citation = h1 ? inline(h1[1]) : `WAC ${id}`;
  const caption = h2 ? inline(h2[1]) : null;

  const start = html.indexOf("<div id='contentWrapper'");
  const end = html.indexOf('ContentPlaceHolder1_pnlExpanded');
  const bodyHtml = start === -1 ? html : html.slice(html.indexOf('>', start) + 1, end === -1 ? undefined : html.lastIndexOf('<div', end));
  const { text, history, authority_rcw } = splitHistory(toText(bodyHtml));

  return {
    found: true,
    citation,
    section: id,
    title: cite.title,
    chapter: `${cite.title}-${cite.chapter}`,
    caption,
    text,
    text_chars: text.length,
    history,
    authority_rcw,
    url,
    pdf_url: `${url}&pdf=true`,
    filings_url: `${WAC_FILINGS}${encodeURIComponent(id)}`,
    data_as_of: new Date().toISOString(),
    source: SOURCE,
    attribution: ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------
// WAC: browse titles / chapters / sections
// ---------------------------------------------------------------------------

async function wacBrowse(args: Record<string, unknown>): Promise<unknown> {
  const raw = String(args.cite ?? '').trim();
  const data_as_of = new Date().toISOString();

  if (!raw) {
    const res = await pwFetch(WAC_HOME, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Washington Legislature returned HTTP ${res.status} for the WAC title index`);
    const html = await res.text();
    const titles: { title: string; agency: string; url: string }[] = [];
    const re = /href="default\.aspx\?cite=(\d+[A-Z]?)">\s*Title\s*[\dA-Z]+\s*<\/a><\/td><td>([^<]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      titles.push({ title: m[1], agency: inline(m[2]), url: `${WAC_BASE}${m[1]}` });
    }
    if (titles.length === 0) throw new Error('WAC title index parsed to zero titles — the page layout has changed');
    return { level: 'titles', count: titles.length, titles, url: WAC_HOME, data_as_of, source: SOURCE };
  }

  const cite = parseWac(raw);
  if (!cite) return { found: false, reason: 'unparsed_cite', message: `"${raw}" is not a WAC title or chapter.`, hint: WAC_FORMAT_HINT };
  if (cite.section) {
    return {
      found: false,
      reason: 'is_a_section',
      message: `"${citeString(cite)}" is a section. Call wa_wac_section for its text, or browse its chapter with {cite: "${cite.title}-${cite.chapter}"}.`,
    };
  }
  const id = citeString(cite);
  const url = `${WAC_BASE}${encodeURIComponent(id)}`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    return { found: false, reason: cite.chapter ? 'chapter_not_found' : 'title_not_found', cite: id, message: `No WAC ${id} (the site redirected instead of serving it).` };
  }
  if (!res.ok) throw new Error(`Washington Legislature returned HTTP ${res.status} for WAC ${id}`);
  const html = await res.text();
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/);
  const h2 = html.match(/<h2>([\s\S]*?)<\/h2>/);
  const heading = h2 ? inline(h2[1]) : null;
  const start = html.indexOf("<div id='contentWrapper'");
  const body = start === -1 ? html : html.slice(start);

  if (!cite.chapter) {
    const chapters: { chapter: string; caption: string; url: string }[] = [];
    const re = /cite=(\d+[A-Z]?-\d+[A-Z]?)'>[^<]*<\/a><\/td><td[^>]*>([\s\S]*?)<\/td>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) chapters.push({ chapter: m[1], caption: inline(m[2]), url: `${WAC_BASE}${m[1]}` });
    if (chapters.length === 0) {
      return { found: false, reason: 'title_not_found', cite: id, message: `WAC Title ${id} lists no chapters — it does not exist, or every chapter has been repealed.`, url };
    }
    return { level: 'chapters', cite: id, heading: h1 ? inline(h1[1]) : `Title ${id} WAC`, agency: heading, count: chapters.length, chapters, url, data_as_of, source: SOURCE };
  }

  const sections: { section: string; caption: string; subheading: string | null; url: string }[] = [];
  let subheading: string | null = null;
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(body))) {
    const row = r[1];
    const sub = row.match(/<td colspan="3"><div[^>]*>([\s\S]*?)<\/div>/);
    if (sub) {
      subheading = inline(sub[1]) || null;
      continue;
    }
    const sec = row.match(/<td[^>]*>(\d+[A-Z]?-\d+[A-Z]?-\d+[A-Z]?)<\/td><td[^>]*>([\s\S]*?)<\/td>/);
    if (sec) sections.push({ section: sec[1], caption: inline(sec[2]), subheading, url: `${WAC_BASE}${sec[1]}` });
  }
  if (sections.length === 0) {
    return { found: false, reason: 'chapter_not_found', cite: id, message: `WAC chapter ${id} lists no sections — it does not exist, or the chapter has been repealed (see its dispositions page).`, url, dispositions_url: `${WAC_BASE}${id}&dispo=true` };
  }
  return {
    level: 'sections',
    cite: id,
    heading: h1 ? inline(h1[1]) : `Chapter ${id} WAC`,
    caption: heading,
    count: sections.length,
    sections,
    url,
    full_chapter_url: `${url}&full=true`,
    data_as_of,
    source: SOURCE,
  };
}

// ---------------------------------------------------------------------------
// WAC: full-text search (SearchUnify behind leg.wa.gov/search)
// ---------------------------------------------------------------------------

const SU_MARK = /___su-highlight-(?:start|end)___/g;

function cleanHighlight(s: unknown): string {
  return String(s ?? '').replace(SU_MARK, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function refreshSuConfig(): Promise<boolean> {
  const res = await pwFetch(SU_CLIENT_JS, { headers: { 'User-Agent': UA } }, 'leg.wa.gov search client');
  if (!res.ok) return false;
  const js = await res.text();
  const search = js.match(/"search"\s*:\s*"(https:\/\/[^"]+)"/)?.[1];
  const uid = js.match(/"uid"\s*:\s*"([0-9a-f-]{20,})"/)?.[1];
  const accessToken = js.match(/"accessToken"\s*:\s*"([0-9a-f]{16,})"/)?.[1];
  if (!search || !uid || !accessToken) return false;
  const changed = search !== suConfig.search || uid !== suConfig.uid || accessToken !== suConfig.accessToken;
  suConfig = { search, uid, accessToken };
  return changed;
}

async function suSearch(query: string, size: number): Promise<{ status: number; body: any }> {
  const payload = {
    react: 1,
    searchString: query,
    from: 0,
    sortby: '_score',
    orderBy: 'desc',
    pageNo: 1,
    aggregations: [
      { type: '_index', filter: ['1_7_wac'] },
      { type: '_type', filter: ['wac'] },
    ],
    uid: suConfig.uid,
    accessToken: suConfig.accessToken,
    resultsPerPage: size,
    exactPhrase: '',
    withOneOrMore: '',
    withoutTheWords: '',
    pageSize: size,
    sid: '',
    language: 'en',
    mergeSources: false,
    versionResults: true,
    showMoreSummary: false,
    minSummaryLength: false,
    suCaseCreate: false,
  };
  const res = await pwFetch(
    `${suConfig.search}/search/searchResultByPost`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(payload),
    },
    'Washington Legislature search',
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

const ARCHIVE_FILE_RE = /WAC\s+(\d+[A-Z]?)\s*-\s*(\d+[A-Z]?)\s*-\s*(\d+[A-Z]?)\.htm$/i;
const ARCHIVE_CHAPTER_RE = /WAC\s+(\d+[A-Z]?)\s*-\s*(\d+[A-Z]?)\s+CHAPTER\.htm$/i;
const ARCHIVE_TITLE_RE = /WAC\s+(\d+[A-Z]?)\s+TITLE\.htm$/i;

async function wacSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
  const prefixCite = args.cite_prefix ? parseWac(args.cite_prefix) : null;
  if (args.cite_prefix && !prefixCite) {
    return { found: false, reason: 'unparsed_cite_prefix', message: `"${args.cite_prefix}" is not a WAC title or chapter.`, hint: WAC_FORMAT_HINT };
  }
  const prefix = prefixCite ? citeString(prefixCite) + '-' : null;
  const size = prefix ? 50 : limit;

  let { status, body } = await suSearch(query, size);
  if (status !== 200 || body?.statusCode !== 200) {
    // The public client token can rotate when the Legislature republishes its
    // search client; re-read it from the bundle once and retry.
    const changed = await refreshSuConfig();
    if (changed) ({ status, body } = await suSearch(query, size));
  }
  if (status !== 200 || body?.statusCode !== 200) {
    throw new Error(
      `Washington Legislature search returned HTTP ${status}${body?.message ? ` (${String(body.message).slice(0, 120)})` : ''}. ` +
        'The full-text index is the leg.wa.gov site search; wa_wac_browse (title → chapter → section captions) still works without it.',
    );
  }

  const hits: any[] = body?.result?.hits ?? [];
  const results = hits
    .map((h) => {
      const href = String(h.href ?? h._id ?? '');
      let file = '';
      try {
        file = decodeURIComponent(href.split('/').pop() ?? '');
      } catch {
        file = href.split('/').pop() ?? '';
      }
      const hl = h.highlight ?? {};
      const sec = file.match(ARCHIVE_FILE_RE);
      const chap = file.match(ARCHIVE_CHAPTER_RE);
      const ttl = file.match(ARCHIVE_TITLE_RE);
      const citation = sec ? `${sec[1]}-${sec[2]}-${sec[3]}` : chap ? `${chap[1]}-${chap[2]}` : ttl ? ttl[1] : null;
      const kind = sec ? 'section' : chap ? 'chapter' : ttl ? 'title' : 'other';
      let caption = cleanHighlight(hl['CaptionsTitles.en']?.[0]);
      const summary = cleanHighlight(hl['SummaryToDisplay']?.[0] ?? hl['1_7_wac___wac___Content.en']?.[0]);
      if (!caption && citation) {
        const cm = summary.match(new RegExp(`^(?:PDF\\s*)?WAC\\s+${citation.replace(/[-]/g, '\\-')}\\s+(.{3,160}?\\.)(?:\\s|$)`));
        if (cm) caption = cm[1];
      }
      const snippets = (hl['Text.en'] ?? []).map(cleanHighlight).filter(Boolean);
      const snippet = snippets.length ? snippets.join(' … ') : summary.replace(/^(?:PDF\s*)?WAC\s+[\dA-Z-]+\s*/, '');
      return {
        citation: citation ? `WAC ${citation}` : null,
        cite: citation,
        kind,
        caption: caption || null,
        snippet: snippet.slice(0, 600),
        url: citation ? `${WAC_BASE}${citation}` : href,
        score: typeof h._score === 'number' ? Math.round(h._score * 10) / 10 : null,
      };
    })
    .filter((r) => !prefix || (r.cite ?? '').startsWith(prefix) || r.cite === prefix.slice(0, -1))
    .slice(0, limit);

  const total: number = Number(body?.result?.total ?? 0);
  return {
    query,
    cite_prefix: prefix ? prefix.slice(0, -1) : null,
    total_matches: prefix ? null : total,
    total_matches_note: prefix
      ? `Filtered client-side to WAC ${prefix.slice(0, -1)} from the top ${size} of ${total} index-wide matches; a chapter with many matches past rank ${size} is under-counted here.`
      : 'Index-wide match count from the Legislature search; results are the top-scored ones.',
    returned: results.length,
    results,
    ...(results.length === 0
      ? { note: `The Legislature's WAC full-text index returned ${total} matches for "${query}"${prefix ? ` (none under WAC ${prefix.slice(0, -1)} in the top ${size})` : ''}. Try fewer or different words; agency rules use regulatory vocabulary ("employer", "licensee", "permittee").` }
      : {}),
    search_url: `https://leg.wa.gov/search?searchString=${encodeURIComponent(query)}&activeType=1_7_wac`,
    data_as_of: new Date().toISOString(),
    source: 'Washington State Legislature site search (SearchUnify index of lawfilesext.leg.wa.gov WAC files), keyless',
    attribution: ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------
// WAC: archived section text by year
// ---------------------------------------------------------------------------

const FIRST_HTML_ARCHIVE_YEAR = 2019;
const FIRST_ARCHIVE_YEAR = 2004; // lawfilesext holds scans back to 1977; the Legislature advertises 2004+

/** Fixed-width archive name fields: numeric part right-aligned to 3, suffix letter appended, padded to 4. */
function field(part: string): string {
  const m = part.match(/^(\d+)([A-Z]?)$/);
  const num = m ? m[1] : part;
  const suffix = m ? m[2] : '';
  return (num.padStart(3, ' ') + suffix).padEnd(4, ' ');
}

function archiveCandidates(year: number, c: Required<WacCite>): string[] {
  const t = field(c.title);
  const ch = field(c.chapter);
  const titleDir = `WAC ${t} TITLE`;
  const chapterDir = `WAC ${t}-${ch} CHAPTER`;
  const file = `WAC ${t}-${ch}-${c.section}.htm`;
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  // 2019–2023: nested by title; 2024+: flat by chapter. Try the likely one first.
  const nested = `${WAC_ARCHIVE}${year}/htm/${enc(titleDir)}/${enc(chapterDir)}/${enc(file)}`;
  const flat = `${WAC_ARCHIVE}${year}/htm/${enc(chapterDir)}/${enc(file)}`;
  return year >= 2024 ? [flat, nested] : [nested, flat];
}

async function wacArchivedSection(args: Record<string, unknown>): Promise<unknown> {
  const cite = parseWac(args.section);
  if (!cite || !cite.section || !cite.chapter) {
    return { found: false, reason: 'unparsed_section', message: `"${args.section}" is not a WAC section citation.`, hint: WAC_FORMAT_HINT };
  }
  const year = Number(args.year);
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < FIRST_ARCHIVE_YEAR || year >= thisYear) {
    return {
      found: false,
      reason: 'year_out_of_range',
      message: `year must be an integer from ${FIRST_ARCHIVE_YEAR} to ${thisYear - 1}; the archive is a year-end snapshot, so the current year is wa_wac_section.`,
      html_years: `${FIRST_HTML_ARCHIVE_YEAR}–${thisYear - 1}`,
      pdf_only_years: `${FIRST_ARCHIVE_YEAR}–${FIRST_HTML_ARCHIVE_YEAR - 1}`,
    };
  }
  const id = citeString(cite);
  const full = cite as Required<WacCite>;
  const data_as_of = new Date().toISOString();

  if (year < FIRST_HTML_ARCHIVE_YEAR) {
    // Scanned/printed volumes only. 2016–2018 carry a per-chapter PDF whose
    // name follows the fixed-width scheme; earlier years are supplements and
    // bound volumes with no per-chapter file, so point at the year directory.
    const pdfName = `WAC ${field(full.title)}-${field(full.chapter)} CHAPTER.pdf`;
    const pdfUrl = `${WAC_ARCHIVE}${year}/${encodeURIComponent(pdfName)}`;
    let chapter_pdf_url: string | null = null;
    if (year >= 2016) {
      const head = await pwFetch(pdfUrl, { method: 'HEAD', headers: { 'User-Agent': UA } });
      if (head.ok) chapter_pdf_url = pdfUrl;
    }
    return {
      found: false,
      reason: 'pdf_only_year',
      section: id,
      year,
      message: `The ${year} WAC archive is published as PDF only; this tool returns text for ${FIRST_HTML_ARCHIVE_YEAR} onward.`,
      chapter_pdf_url,
      archive_directory_url: `${WAC_ARCHIVE}${year}/`,
      hint: `wa_wac_filings({cite: "${id}"}) lists every WSR rule-making filing that changed this section, with dates, which usually answers "what did it say in ${year}" without the scan.`,
      data_as_of,
      source: SOURCE,
    };
  }

  const tried: string[] = [];
  for (const url of archiveCandidates(year, full)) {
    tried.push(url);
    const res = await pwFetch(url, { headers: { 'User-Agent': UA } }, 'Washington WAC archive');
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Washington WAC archive returned HTTP ${res.status} for ${url}`);
    const html = await res.text();
    const citation = fieldOf(html, 'Citations') ?? `WAC ${id}`;
    const caption = fieldOf(html, 'CaptionsTitles');
    const textField = html.match(/<!-- field: Text -->([\s\S]*?)(?:<div[^>]*>\[<!-- field: History -->|<\/body>)/);
    const text = toText(textField ? textField[1] : html);
    const history = fieldOf(html, 'History');
    const authority_rcw = Array.from(new Set((history ?? '').match(/\b\d+[A-Z]?\.\d+[A-Z]?\.\d+\b/g) ?? []));
    return {
      found: true,
      citation,
      section: id,
      year,
      archive: `Washington Administrative Code ${year} Archive (year-end snapshot)`,
      caption,
      text,
      text_chars: text.length,
      history,
      authority_rcw,
      url,
      current_url: `${WAC_BASE}${id}`,
      data_as_of,
      source: SOURCE,
      attribution: ATTRIBUTION,
    };
  }
  return {
    found: false,
    reason: 'section_not_in_archive',
    section: id,
    year,
    message: `WAC ${id} is not in the ${year} archive (HTTP 404 at both layouts). Either the section did not exist at the end of ${year}, or it was numbered differently then.`,
    tried,
    hint: `wa_wac_filings({cite: "${id}"}) shows when the section was adopted or renumbered; wa_wac_section returns the current text.`,
    data_as_of,
    source: SOURCE,
  };
}

// ---------------------------------------------------------------------------
// WAC: WSR rule-making filings affecting a section or chapter
// ---------------------------------------------------------------------------

async function wacFilings(args: Record<string, unknown>): Promise<unknown> {
  const cite = parseWac(args.cite);
  if (!cite || !cite.chapter) {
    return { found: false, reason: 'unparsed_cite', message: `"${args.cite}" is not a WAC section or chapter citation.`, hint: WAC_FORMAT_HINT };
  }
  const id = citeString(cite);
  const url = `${WAC_FILINGS}${encodeURIComponent(id)}`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    return { found: false, reason: 'cite_not_found', cite: id, message: `The filings page redirected instead of listing WAC ${id} (HTTP ${res.status}).` };
  }
  if (!res.ok) throw new Error(`Washington Legislature returned HTTP ${res.status} for WAC ${id} filings`);
  const html = await res.text();
  const filings: { wsr: string; type: string; filed: string; url: string }[] = [];
  const re = /<a[^>]*href='([^']*law\/wsr\/[^']*)'>\s*([\d-]+)\s*<\/a>\s*<\/td>\s*<td>\s*([\s\S]*?)\s*<\/td>\s*<td>\s*([\d/]+)\s*<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    filings.push({ wsr: m[2].trim(), type: inline(m[3]), filed: m[4].trim(), url: m[1] });
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return {
    citation: h1 ? inline(h1[1]) : `WAC ${id}`,
    cite: id,
    level: cite.section ? 'section' : 'chapter',
    count: filings.length,
    filings,
    ...(filings.length === 0
      ? { note: `The Legislature lists no Washington State Register filings for WAC ${id}. For a valid cite that means no agency rule-making has touched it since the WSR index began; for an unknown cite the page is simply empty — confirm with wa_wac_section or wa_wac_browse.` }
      : {}),
    url,
    data_as_of: new Date().toISOString(),
    source: SOURCE,
    attribution: ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'wa_rcw_section',
    description:
      'Get the FULL TEXT of a section of the Revised Code of Washington (RCW) — Washington state STATUTES — by citation. "RCW 9A.32.030" is first degree murder. Returns the statutory text and its heading. Keyless. Use for "what does RCW 46.61.502 say", "text of RCW 49.60.180", or to check a Washington statute a case relies on. For agency RULES (Washington Administrative Code, citations like "WAC 296-800-110") use wa_wac_section instead.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'RCW citation, e.g. "9A.32.030" or "46.61.502". Title.chapter.section.' },
      },
      required: ['section'],
    },
  },
  {
    name: 'wa_wac_section',
    description:
      'Get the CURRENT FULL TEXT of a section of the Washington Administrative Code (WAC) — Washington state agency RULES / regulations — by citation. "WAC 296-800-110" is L&I\'s safe-workplace summary; "458-20-178" is the Department of Revenue use-tax rule. Returns the rule text, its caption, the statutory-authority history (every WSR filing that amended it, with filed/effective dates) and the RCW sections the agency cited as authority. A repealed or nonexistent section is reported as found:false (the site redirects it). Keyless. Use for "what does WAC 296-800-110 say", "text of WAC 388-76-10000", or to check a Washington regulation an agency decision cites. For STATUTES (RCW) use wa_rcw_section; for past years use wa_wac_archived_section; to search by topic use wa_wac_search.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'WAC citation, title-chapter-section, e.g. "296-800-110" or "WAC 458-20-178". Chapter and title parts may carry a letter suffix ("296-14A-100", "132C-120-010").' },
      },
      required: ['section'],
    },
  },
  {
    name: 'wa_wac_search',
    description:
      'Search the FULL TEXT of the Washington Administrative Code (WAC) by topic or keyword — "workplace safety bulletin board", "security deposit", "septic system permit", "cannabis retailer". Calls the Washington State Legislature\'s own full-text search index of every WAC section (it matches rule TEXT, not just captions), returns matching citations with captions, highlighted snippets and the index-wide match count. Optionally restrict to a title or chapter with cite_prefix ("296" for L&I, "458-20" for Revenue excise-tax rules). Call wa_wac_section with a citation for the full text and history. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "safety bulletin board" or "landlord deposit". Plain words; the index is Elasticsearch-style (all terms, stemmed).' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
        cite_prefix: { type: 'string', description: 'Optional WAC title or chapter to restrict results to, e.g. "296" or "296-800".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wa_wac_browse',
    description:
      'Browse the structure of the Washington Administrative Code (WAC): with no cite, lists every WAC TITLE with the agency it belongs to (Title 296 = Labor and Industries, 458 = Revenue, 388 = Social and Health Services, 173 = Ecology, 246 = Health); with a title ("296") lists its CHAPTERS with captions; with a chapter ("296-800") lists its SECTIONS with captions and subheadings. Use to find which chapter covers a topic before calling wa_wac_section, or to enumerate every rule in a chapter. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        cite: { type: 'string', description: 'Omit for all titles; a title number ("296") for its chapters; a chapter ("296-800") for its sections.' },
      },
    },
  },
  {
    name: 'wa_wac_archived_section',
    description:
      'Get the text of a Washington Administrative Code (WAC) section AS IT STOOD at the end of a PAST YEAR, from the Legislature\'s annual WAC archive. Year-end snapshots with full text for 2019 onward (e.g. "WAC 296-800-110 in 2020"); 2004–2018 are PDF-only and the tool returns the chapter PDF link for 2016–2018 and the archive directory for earlier years rather than text. Returns the archived text, caption and the history line as printed that year, so you can diff it against wa_wac_section (current). Keyless. Use for "what did WAC 314-55-010 say in 2021", or to check which version of a rule applied on a date.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'WAC section citation, e.g. "296-800-110".' },
        year: { type: 'number', description: 'Archive year, 2004–last year. Full text for 2019 onward; PDF-only before that.' },
      },
      required: ['section', 'year'],
    },
  },
  {
    name: 'wa_wac_filings',
    description:
      'List the Washington State Register (WSR) rule-making FILINGS that affected a Washington Administrative Code (WAC) section or chapter — the amendment history as agency actions: WSR number, filing type (Permanent Rule, Proposal Original Notice, Emergency Rule, Expedited Rule Making, Preproposal Statement of Inquiry…), date filed, and a link to the filing text. Newest first. Use for "when was WAC 296-800-110 last amended", "is there a pending proposal to change chapter 458-20 WAC", or to trace a rule\'s rule-making record. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        cite: { type: 'string', description: 'WAC section ("296-800-110") or chapter ("296-800").' },
      },
      required: ['cite'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'wa_rcw_section':
      return rcwSection(args);
    case 'wa_wac_section':
      return wacSection(args);
    case 'wa_wac_search':
      return wacSearch(args);
    case 'wa_wac_browse':
      return wacBrowse(args);
    case 'wa_wac_archived_section':
      return wacArchivedSection(args);
    case 'wa_wac_filings':
      return wacFilings(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
