// ReplyTrack — background service worker.
// Keeps a pinned LinkedIn messaging tab alive and reloads it every 20 minutes
// (each load makes content.js sync), resolves profile links, posts replies to
// the Apps Script web app, remembers what was already sent, and shows the
// "logged out" notification.

const log = (...a) => console.log("[ReplySync]", ...a);
const warn = (...a) => console.warn("[ReplySync]", ...a);

const MESSAGING_URL = "https://www.linkedin.com/messaging/";
const MESSAGING_MATCH = "https://www.linkedin.com/messaging/*";
const MESSAGING_RE = /^https:\/\/www\.linkedin\.com\/messaging\//i;
const LINKEDIN_RE = /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i;
// Where LinkedIn sends you when the session is gone or needs a security check.
const LOGIN_RE = /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\/(login|uas\/|checkpoint|authwall|signup|m\/login|start\/join)/i;

const ALARM = "replysync-reload";
const ALARM_MINUTES = 20;
const WAKE_ALARM = "replysync-wake"; // one-off: 30 s after the computer wakes / you come back
const WAKE_DELAY_MINUTES = 0.5;
const RETRY_ALARM = "replysync-retry"; // one-off: 1 min after a sync failed for lack of internet
const RETRY_MINUTES = 1;
const IDLE_DETECTION_SECONDS = 5 * 60; // "idle" = no mouse/keyboard for 5 min (sleep and lock always count)
const ONLINE_CHECK_URL = "https://www.linkedin.com/robots.txt";
const STALE_SYNC_MS = 3 * 60 * 1000; // no heartbeat for this long = the sync is dead
const NOTIFY_EVERY_MS = 3 * 60 * 60 * 1000; // repeat the logged-out notification at most every 3 h
const NOTIFICATION_ID = "replysync-logged-out";
const MAX_SENT_HASHES = 20000;
const POST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Storage helpers
//   storage.sync : { tabName, scriptUrl, useGoogleLogin }  (the settings)
//   storage.local: { status, lastSync, sentHashes, vanityCache, syncTabId, loggedOutNotifiedAt }
// ---------------------------------------------------------------------------
async function getSettings() {
	const s = await chrome.storage.sync.get({ tabName: "", scriptUrl: "", useGoogleLogin: false });
	return { tabName: String(s.tabName).trim(), scriptUrl: String(s.scriptUrl).trim(), useGoogleLogin: !!s.useGoogleLogin };
}
const isConfigured = s => !!(s.tabName && s.scriptUrl);

async function getLocal(key, fallback) {
	const r = await chrome.storage.local.get(key);
	return r[key] === undefined ? fallback : r[key];
}

async function setStatus(patch) {
	const status = await getLocal("status", {});
	const next = { ...status, ...patch };
	await chrome.storage.local.set({ status: next });
	return next;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stop / Start sync (popup). While storage.local.syncStopped is true nothing
// syncs automatically, and every request from a sync still running is refused.
const isStopped = async () => !!(await getLocal("syncStopped", false));
const onStopCallbacks = new Set(); // cancels work in progress (the method-3 tab) when Stop is pressed

// ---------------------------------------------------------------------------
// Internet connection
// ---------------------------------------------------------------------------
// fetch() only rejects when the network itself fails (an HTTP error still
// resolves), so a rejection or a 10 s timeout means "no internet".
async function isOnline() {
	if (navigator.onLine === false) return false;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 10000);
	try {
		await fetch(ONLINE_CHECK_URL, { method: "HEAD", cache: "no-store", credentials: "omit", signal: ctrl.signal });
		return true;
	} catch (e) {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function scheduleRetry(why) {
	log(`${why} — retrying in ${RETRY_MINUTES} minute.`);
	chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MINUTES });
	await setStatus({ syncing: false, progress: "", lastError: `No internet connection — retrying in ${RETRY_MINUTES} minute.` });
}

// Counted per sync; a sync that failed after network errors is retried in 1 minute.
async function noteNetworkFailure() {
	const status = await getLocal("status", {});
	await setStatus({ networkFailures: (status.networkFailures || 0) + 1 });
}

// Short, stable hash (cyrb53) — used to remember which messages were sent.
function hash(str) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------------------------------------------------------------------------
// LinkedIn profile links
// ---------------------------------------------------------------------------
// The part after /in/, as it appears in the link (still URL-encoded).
function slugOf(url) {
	const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s"']+)/i);
	return m ? m[1] : "";
}
// Encoded member ids look like ACoAAB3x… (sometimes ACwAA…) instead of a vanity name.
const isMemberId = slug => /^AC[ow]AA[A-Za-z0-9_-]{6,}$/.test(String(slug || ""));
const profileUrlOf = slug => `https://www.linkedin.com/in/${slug}`;

const RESOLVE_TAB_TIMEOUT_MS = 20000;
const isNetworkError = e => !!e && e.name === "TypeError" && /failed to fetch|networkerror/i.test(e.message || "");

// The publicIdentifier (vanity name) of the member whose id is `id`, found
// anywhere in LinkedIn API data. Only an object that also mentions this id
// (e.g. entityUrn "urn:li:fs_miniProfile:ACoAA…") counts, so your own
// profile — which is in most responses too — is never picked up.
function publicIdentifierFor(data, id) {
	const stack = [data];
	let seen = 0;
	while (stack.length && seen++ < 50000) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		if (Array.isArray(node)) {
			stack.push(...node);
			continue;
		}
		const pid = node.publicIdentifier;
		if (typeof pid === "string" && pid && !isMemberId(pid)) {
			const mentionsId = Object.entries(node).some(([k, v]) => k !== "publicIdentifier" && typeof v === "string" && v.includes(id));
			if (mentionsId) return pid;
		}
		for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
	}
	return "";
}

// Text of the innermost {...} around position pos (JSON embedded in a page), or "".
function enclosingObject(text, pos) {
	for (let start = text.lastIndexOf("{", pos); start >= 0 && pos - start < 20000; start = text.lastIndexOf("{", start - 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < text.length && i - start < 200000; i++) {
			const c = text[i];
			if (inString) {
				if (c === "\\") i++;
				else if (c === '"') inString = false;
			} else if (c === '"') inString = true;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				if (i > pos) return text.slice(start, i + 1);
				break;
			}
		}
	}
	return "";
}

// -> { vanity, where } from a profile page's HTML.
function vanityFromHtml(html, id) {
	const patterns = [
		["<link rel=canonical>", /<link[^>]*rel=["']canonical["'][^>]*href=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)/i],
		["<link rel=canonical>", /<link[^>]*href=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)[^>]*rel=["']canonical["']/i],
		['<meta property="og:url">', /<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)/i],
		['<meta property="og:url">', /<meta[^>]*content=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)[^>]*property=["']og:url["']/i],
	];
	for (const [where, re] of patterns) {
		const m = html.match(re);
		if (m && !isMemberId(m[1])) return { vanity: m[1], where };
	}
	// Page data (often HTML-encoded JSON): a "publicIdentifier" whose own
	// object also contains this member's id. Your own profile's doesn't.
	const text = html.replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	const re = /\\?"publicIdentifier\\?"\s*:\s*\\?"([^"\\]+)\\?"/g;
	let m;
	while ((m = re.exec(text))) {
		if (isMemberId(m[1])) continue;
		if (enclosingObject(text, m.index).includes(id)) return { vanity: m[1], where: '"publicIdentifier" in page data' };
	}
	return { vanity: "", where: "" };
}

// Method 1: LinkedIn's own profile API, with your session's csrf token.
async function resolveViaApi(id) {
	const name = "method 1 (profile API)";
	const cookie = await chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" });
	const csrf = cookie ? cookie.value.replace(/^"|"$/g, "") : "";
	if (!csrf) {
		log(`Resolve ${id} — ${name}: no JSESSIONID cookie on www.linkedin.com, skipped.`);
		return {};
	}
	const apiUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(id)}/profileView`;
	const res = await fetch(apiUrl, {
		credentials: "include",
		headers: {
			"csrf-token": csrf,
			accept: "application/vnd.linkedin.normalized+json+2.1",
			"x-restli-protocol-version": "2.0.0",
		},
	});
	const body = await res.text();
	let data = null;
	try {
		data = JSON.parse(body);
	} catch (e) {
		/* not JSON — logged below */
	}
	const vanity = data ? publicIdentifierFor(data, id) : "";
	const found = vanity ? `found publicIdentifier "${vanity}"` : data ? "no publicIdentifier for this member in the response" : `response is not JSON: ${body.slice(0, 120).replace(/\s+/g, " ")}`;
	log(`Resolve ${id} — ${name}: GET ${apiUrl} → HTTP ${res.status}; ${found}`);
	return { vanity };
}

// Method 2: the /in/ACoAA… page itself — redirect URL, canonical/og:url, or page data.
async function resolveViaHtml(id) {
	const name = "method 2 (profile page HTML)";
	const pageUrl = profileUrlOf(id) + "/";
	const res = await fetch(pageUrl, { credentials: "include", redirect: "follow" });
	if (LOGIN_RE.test(res.url)) {
		log(`Resolve ${id} — ${name}: GET ${pageUrl} → HTTP ${res.status}; redirected to the login page ${res.url}`);
		return { loggedOut: true };
	}
	let vanity = slugOf(res.url);
	let where = "the redirect URL";
	if (!vanity || isMemberId(vanity)) ({ vanity, where } = vanityFromHtml(await res.text(), id));
	const found = vanity ? `found "${vanity}" in ${where}` : "no vanity URL in the redirect, canonical link, og:url or page data";
	log(`Resolve ${id} — ${name}: GET ${pageUrl} → HTTP ${res.status}, ended at ${res.url}; ${found}`);
	return { vanity };
}

// Method 3: open the link in a background tab and read the URL LinkedIn's
// own page code switches to. The tab is always closed afterwards.
async function resolveViaTab(id) {
	const name = "method 3 (background tab)";
	const pageUrl = profileUrlOf(id) + "/";
	const syncTab = await getSyncTab();
	let tab;
	try {
		tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false, ...(syncTab ? { windowId: syncTab.windowId } : {}) });
	} catch (e) {
		log(`Resolve ${id} — ${name}: could not open a tab (${e.message || e}).`);
		return {};
	}
	log(`Resolve ${id} — ${name}: opened tab ${tab.id} at ${pageUrl}, waiting up to ${RESOLVE_TAB_TIMEOUT_MS / 1000} s for a /in/ URL without the id.`);
	try {
		const result = await new Promise(resolve => {
			let finished = false;
			const finish = r => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				chrome.tabs.onUpdated.removeListener(onUpdated);
				onStopCallbacks.delete(cancel);
				resolve(r);
			};
			const cancel = () => finish({ stopped: true });
			onStopCallbacks.add(cancel);
			const check = url => {
				if (!url) return;
				if (LOGIN_RE.test(url)) return finish({ loggedOut: true, url });
				const v = slugOf(url);
				if (v && !isMemberId(v)) finish({ vanity: v, url });
			};
			const onUpdated = (tabId, info, t) => {
				if (tabId === tab.id) check(info.url || (t && t.url));
			};
			const timer = setTimeout(() => finish({ timedOut: true }), RESOLVE_TAB_TIMEOUT_MS);
			chrome.tabs.onUpdated.addListener(onUpdated);
			// In case LinkedIn redirected before the listener was attached.
			chrome.tabs.get(tab.id).then(t => check(t.url), () => finish({ closed: true }));
		});
		if (result.vanity) log(`Resolve ${id} — ${name}: tab reached ${result.url}; found "${result.vanity}"`);
		else if (result.loggedOut) log(`Resolve ${id} — ${name}: tab was sent to the login page ${result.url}`);
		else if (result.closed) log(`Resolve ${id} — ${name}: the tab was closed before it finished.`);
		else if (result.stopped) log(`Resolve ${id} — ${name}: cancelled because sync was stopped.`);
		else {
			const last = await chrome.tabs.get(tab.id).then(t => t.url, () => "?");
			log(`Resolve ${id} — ${name}: timed out after ${RESOLVE_TAB_TIMEOUT_MS / 1000} s; tab was still at ${last}`);
		}
		return result;
	} finally {
		chrome.tabs.remove(tab.id).catch(() => {});
	}
}

// /in/ACoAA… -> /in/vanity-name. Tries the three methods above in order and
// stops at the first that works. Results are cached, so each person is
// resolved only once.
async function resolveProfile(url) {
	const slug = slugOf(url);
	if (!slug) return { profileUrl: null, reason: "not a /in/ profile link" };
	if (!isMemberId(slug)) return { profileUrl: profileUrlOf(slug) };

	const cache = await getLocal("vanityCache", {});
	if (cache[slug]) {
		log(`Resolve ${slug}: from cache → ${cache[slug]}`);
		return { profileUrl: cache[slug], cached: true };
	}

	for (const [name, method] of [
		["method 1 (profile API)", resolveViaApi],
		["method 2 (profile page HTML)", resolveViaHtml],
		["method 3 (background tab)", resolveViaTab],
	]) {
		if (await isStopped()) return { profileUrl: null, stopped: true };
		let r;
		try {
			r = await method(slug);
		} catch (e) {
			warn(`Resolve ${slug} — ${name}: error: ${e.message || e}`);
			if (isNetworkError(e)) {
				await noteNetworkFailure();
				warn(`Resolve ${slug}: no internet connection — not trying the remaining methods.`);
				break;
			}
			continue;
		}
		if (r.stopped) return { profileUrl: null, stopped: true };
		if (r.loggedOut) return { profileUrl: null, loggedOut: true };
		if (r.vanity && !isMemberId(r.vanity)) {
			const profileUrl = profileUrlOf(r.vanity);
			await cacheVanity(slug, profileUrl);
			log(`Resolved ${slug} → ${profileUrl} (${name}, now cached)`);
			return { profileUrl };
		}
	}
	warn(`Could not resolve ${slug} — every method failed (details in the lines above).`);
	return { profileUrl: null, reason: "all lookup methods failed" };
}

async function cacheVanity(memberId, profileUrl) {
	if (!isMemberId(memberId) || !slugOf(profileUrl) || isMemberId(slugOf(profileUrl))) return;
	const cache = await getLocal("vanityCache", {});
	cache[memberId] = profileUrl;
	await chrome.storage.local.set({ vanityCache: cache });
}

// ---------------------------------------------------------------------------
// Google Sheet (Apps Script web app)
// ---------------------------------------------------------------------------
// Returns { status, transient }. transient = network trouble worth retrying next sync.
async function postToSheet(payload, settings) {
	let lastError = "";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
		try {
			const res = await fetch(settings.scriptUrl, {
				method: "POST",
				// text/plain keeps this a "simple" request; Apps Script still gets the JSON.
				headers: { "Content-Type": "text/plain;charset=utf-8" },
				body: JSON.stringify(payload),
				redirect: "follow",
				credentials: settings.useGoogleLogin ? "include" : "omit",
				signal: ctrl.signal,
			});
			const text = (await res.text()).trim();
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			if (text.startsWith("<")) {
				return {
					status: 'error: Apps Script returned a web page instead of a status. Check the deployment has "Who has access: Anyone" and the URL ends in /exec (or the script itself has an error).',
					transient: false,
				};
			}
			return { status: text, transient: false };
		} catch (e) {
			lastError = e.name === "AbortError" ? "timed out" : e.message || String(e);
			warn(`POST to Apps Script failed (attempt ${attempt}): ${lastError}`);
			if (attempt < 2) await sleep(3000);
		} finally {
			clearTimeout(timer);
		}
	}
	await noteNetworkFailure();
	return { status: `error: could not reach Apps Script (${lastError})`, transient: true };
}

// One conversation from content.js -> only messages not sent before -> sheet.
async function postConversation(msg) {
	const settings = await getSettings();
	if (!isConfigured(settings)) return { status: "not set up", fatal: true, sent: 0 };

	const convId = String(msg.conversationId || "");
	// messages: [{ text, sentAt }] (sentAt = when they sent it on LinkedIn, or the capture time)
	const items = [];
	const seen = new Set();
	for (const m of msg.messages || []) {
		const text = String((m && typeof m === "object" ? m.text : m) || "").trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		items.push({ text, sentAt: Number(m && m.sentAt) || Date.now() });
	}
	const sentHashes = await getLocal("sentHashes", {});
	const fresh = items.map(x => ({ ...x, h: hash(convId + "\u0000" + x.text) })).filter(x => !sentHashes[x.h]);
	if (!fresh.length) return { status: "already sent before", sent: 0 };

	// Texts and times go in two parallel lists, so a not-yet-updated Apps Script
	// (which only knows "replies") still writes plain text and never "[object Object]".
	const payload = {
		tab: settings.tabName,
		profileUrl: msg.profileUrl,
		name: msg.name || "",
		replies: fresh.map(x => x.text),
		sentAt: fresh.map(x => x.sentAt),
	};
	log(`Posting ${fresh.length} message(s) from ${payload.name || "?"} (${payload.profileUrl})`);
	const { status, transient } = await postToSheet(payload, settings);
	log(`Apps Script answered: "${status}"`);

	if (status === "ok") {
		const latest = await getLocal("sentHashes", {});
		const now = Date.now();
		for (const x of fresh) latest[x.h] = now;
		await chrome.storage.local.set({ sentHashes: pruneHashes(latest) });
		return { status, sent: fresh.length };
	}
	// Not marked as sent: if this person is added to the tab later, the next
	// sync that sees new activity in this conversation will write them.
	// ("cell full": the Reply cell hit Google's 50,000-character limit; the
	// sheet was left untouched and the other conversations carry on.)
	if (status === "profile not in tab" || status === "cell full") return { status, sent: 0 };
	if (transient || /^busy/i.test(status)) return { status, sent: 0, error: true };
	// "tab not found", "missing column: …", deployment problems: every
	// conversation would fail the same way, so the sync stops.
	return { status, sent: 0, fatal: true };
}

function pruneHashes(map) {
	const keys = Object.keys(map);
	if (keys.length <= MAX_SENT_HASHES) return map;
	keys.sort((a, b) => map[b] - map[a]);
	const kept = {};
	for (const k of keys.slice(0, MAX_SENT_HASHES)) kept[k] = map[k];
	return kept;
}

// ---------------------------------------------------------------------------
// The pinned messaging tab
// ---------------------------------------------------------------------------
async function getSyncTab() {
	const id = await getLocal("syncTabId", null);
	if (id == null) return null;
	try {
		const tab = await chrome.tabs.get(id);
		// If someone navigated the tab away from LinkedIn, leave it alone.
		return LINKEDIN_RE.test(tab.url || tab.pendingUrl || "") ? tab : null;
	} catch (e) {
		return null; // tab was closed (or Chrome restarted, so ids changed)
	}
}

async function isSyncRunning() {
	const status = await getLocal("status", {});
	if (!status.syncing || Date.now() - (status.heartbeatAt || 0) > STALE_SYNC_MS) return false;
	return !!(await getSyncTab());
}

let ensuring = null; // startup, install and the alarm can fire together
function ensureSyncTab(reason) {
	if (!ensuring) ensuring = doEnsureSyncTab(reason).finally(() => (ensuring = null));
	return ensuring;
}

async function doEnsureSyncTab(reason) {
	if (await isStopped()) {
		log(`(${reason}) Sync is stopped — not opening or reloading the LinkedIn tab. Press "Start sync" in the popup to turn it back on.`);
		return null;
	}
	const settings = await getSettings();
	if (!isConfigured(settings)) {
		log(`(${reason}) Not set up yet — enter your tab name and Apps Script URL in the extension's options.`);
		return null;
	}
	if (await isSyncRunning()) {
		log(`(${reason}) A sync is already running — not reloading.`);
		return null;
	}
	// Reloading while offline would only show Chrome's "No internet" page.
	if (!(await isOnline())) {
		await scheduleRetry(`(${reason}) No internet connection`);
		return null;
	}
	await chrome.alarms.clear(RETRY_ALARM);

	let tab = await getSyncTab();
	if (!tab) {
		const tabs = await chrome.tabs.query({ url: MESSAGING_MATCH });
		tab = tabs.find(t => t.pinned) || tabs[0] || null;
	}

	if (tab) {
		await chrome.storage.local.set({ syncTabId: tab.id });
		if (MESSAGING_RE.test(tab.url || "")) {
			log(`(${reason}) Reloading messaging tab ${tab.id}`);
			await chrome.tabs.reload(tab.id);
		} else {
			log(`(${reason}) Sending tab ${tab.id} back to LinkedIn messaging`);
			await chrome.tabs.update(tab.id, { url: MESSAGING_URL });
		}
	} else {
		try {
			tab = await chrome.tabs.create({ url: MESSAGING_URL, pinned: true, active: false });
		} catch (e) {
			// No Chrome window open (e.g. Chrome running in the background) — make one.
			const win = await chrome.windows.create({ url: MESSAGING_URL, focused: false });
			tab = win.tabs[0];
			await chrome.tabs.update(tab.id, { pinned: true });
		}
		await chrome.storage.local.set({ syncTabId: tab.id });
		log(`(${reason}) Opened pinned messaging tab ${tab.id}`);
	}

	// Stop Chrome's Memory Saver from unloading the tab.
	try {
		await chrome.tabs.update(tab.id, { autoDiscardable: false });
	} catch (e) {
		/* older Chrome */
	}
	return tab;
}

// content.js asks this on every messaging page load. Only the pinned sync tab
// syncs; a messaging tab you open yourself is never clicked through.
async function shouldSync(sender) {
	if (await isStopped()) return { ok: false, stopped: true, reason: 'sync is stopped (press "Start sync" in the extension popup)' };
	const settings = await getSettings();
	if (!isConfigured(settings)) return { ok: false, reason: "not set up (open the extension options)" };
	const tab = sender.tab;
	if (!tab) return { ok: false, reason: "no tab" };

	let syncTab = await getSyncTab();
	if (!syncTab && tab.pinned) {
		await chrome.storage.local.set({ syncTabId: tab.id }); // e.g. Chrome restored our pinned tab
		syncTab = tab;
	}
	if (!syncTab || syncTab.id !== tab.id) return { ok: false, reason: "not the pinned sync tab — leaving this tab alone" };

	return { ok: true, tabName: settings.tabName, lastSync: await getLocal("lastSync", null) };
}

// ---------------------------------------------------------------------------
// Logged out
// ---------------------------------------------------------------------------
async function notifyLoggedOut(where) {
	log(`LinkedIn looks logged out (${where}).`);
	await setStatus({ syncing: false, lastError: "LinkedIn is logged out — sign in to LinkedIn in Chrome." });
	const last = await getLocal("loggedOutNotifiedAt", 0);
	if (Date.now() - last < NOTIFY_EVERY_MS) return;
	await chrome.storage.local.set({ loggedOutNotifiedAt: Date.now() });
	chrome.notifications.create(NOTIFICATION_ID, {
		type: "basic",
		iconUrl: "icons/icon128.png",
		title: "ReplyTrack",
		message: "LinkedIn is logged out — please sign in so replies keep syncing.",
		priority: 2,
		requireInteraction: true,
	});
}

chrome.notifications.onClicked.addListener(async id => {
	if (id !== NOTIFICATION_ID) return;
	chrome.notifications.clear(id);
	const tab = (await getSyncTab()) || (await ensureSyncTab("notification click"));
	if (tab) {
		await chrome.tabs.update(tab.id, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
	}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	try {
		const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : "");
		if (!url || !LOGIN_RE.test(url)) return;
		if ((await getLocal("syncTabId", null)) === tabId) await notifyLoggedOut(url);
	} catch (e) {
		warn("onUpdated error:", e);
	}
});

chrome.tabs.onRemoved.addListener(async tabId => {
	try {
		if ((await getLocal("syncTabId", null)) !== tabId) return;
		await chrome.storage.local.remove("syncTabId");
		const status = await getLocal("status", {});
		if (status.syncing) await setStatus({ syncing: false, progress: "", lastError: "The messaging tab was closed during a sync." });
		log("Sync tab was closed — it will be reopened at the next scheduled sync.");
	} catch (e) {
		warn("onRemoved error:", e);
	}
});

// ---------------------------------------------------------------------------
// Startup, install, alarm
// ---------------------------------------------------------------------------
async function ensureAlarm() {
	const alarm = await chrome.alarms.get(ALARM);
	if (!alarm) {
		chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MINUTES, delayInMinutes: ALARM_MINUTES });
		log(`Alarm set: every ${ALARM_MINUTES} minutes`);
	}
}

chrome.runtime.onStartup.addListener(() => {
	ensureAlarm().catch(e => warn("alarm:", e));
	ensureSyncTab("browser startup").catch(e => warn("startup:", e));
});

chrome.runtime.onInstalled.addListener(async details => {
	try {
		await ensureAlarm();
		const settings = await getSettings();
		if (details.reason === "install" && !isConfigured(settings)) chrome.runtime.openOptionsPage();
		else await ensureSyncTab(`extension ${details.reason}`);
	} catch (e) {
		warn("onInstalled:", e);
	}
});

const ALARM_REASONS = {
	[ALARM]: "20-minute alarm",
	[WAKE_ALARM]: "computer active again",
	[RETRY_ALARM]: "retry after no internet",
};
chrome.alarms.onAlarm.addListener(alarm => {
	const reason = ALARM_REASONS[alarm.name];
	if (!reason) return;
	ensureSyncTab(reason).catch(e => warn("alarm:", e));
});

// Woke from sleep, unlocked, or back at the keyboard after 5+ minutes away:
// sync 30 seconds later (gives Wi-Fi time to reconnect).
chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener(async state => {
	if (state !== "active") return;
	if (await isStopped()) return log("Computer is active again — sync is stopped, so nothing happens.");
	log("Computer is active again — syncing in 30 seconds.");
	chrome.alarms.create(WAKE_ALARM, { delayInMinutes: WAKE_DELAY_MINUTES });
});

// The service worker can be restarted at any time; make sure the alarm exists.
ensureAlarm().catch(e => warn("alarm:", e));

// ---------------------------------------------------------------------------
// Messages from content.js, the popup and the options page
// ---------------------------------------------------------------------------
// Requests a running sync makes. Once Stop is pressed they're all refused, so
// the sync can't open another conversation or send anything more to the sheet.
const REFUSED_WHILE_STOPPED = new Set(["sleep", "syncStarted", "syncProgress", "resolveProfile", "cacheVanity", "postConversation"]);

async function handleMessage(msg, sender) {
	if (msg && REFUSED_WHILE_STOPPED.has(msg.type) && (await isStopped())) return { ok: false, stopped: true };
	switch (msg && msg.type) {
		// content.js waits through the background so Chrome's throttling of
		// background-tab timers doesn't stretch a 3-second pause into a minute.
		case "sleep":
			await sleep(Math.max(0, Math.min(Number(msg.ms) || 0, 20000)));
			return { ok: true };

		case "shouldSync":
			return shouldSync(sender);

		case "syncStarted":
			await setStatus({ syncing: true, syncStartedAt: Date.now(), heartbeatAt: Date.now(), progress: "Starting…", lastError: "", networkFailures: 0 });
			return { ok: true };

		case "syncProgress":
			await setStatus({ syncing: true, heartbeatAt: Date.now(), progress: String(msg.text || "") });
			return { ok: true };

		case "syncFinished": {
			// Stopped part-way: keep the old "last sync" time so nothing is skipped later.
			if (await isStopped()) {
				log("Sync was stopped — the last-sync time is not moved forward.");
				return { ok: false, stopped: true };
			}
			if (msg.nextLastSync) await chrome.storage.local.set({ lastSync: msg.nextLastSync });
			await setStatus({
				syncing: false,
				progress: "",
				lastSyncAt: Date.now(),
				lastSent: msg.sent || 0,
				lastSummary: String(msg.summary || ""),
				lastError: String(msg.error || ""),
			});
			if (!msg.error) await chrome.storage.local.remove("loggedOutNotifiedAt");
			log(`Sync finished: ${msg.summary || ""}${msg.error ? " | " + msg.error : ""}`);
			// Failed because of the connection? Try again in 1 minute, not 20.
			if (msg.error || msg.failed > 0) {
				const { networkFailures = 0 } = await getLocal("status", {});
				if (networkFailures > 0 || !(await isOnline())) await scheduleRetry("Sync failed because of the internet connection");
			}
			return { ok: true };
		}

		case "resolveProfile":
			return resolveProfile(msg.url);

		case "cacheVanity":
			await cacheVanity(msg.memberId, msg.profileUrl);
			return { ok: true };

		case "postConversation":
			return postConversation(msg);

		case "loggedOut":
			await notifyLoggedOut(msg.where || "messaging page");
			return { ok: true };

		case "syncNow": {
			if (await isStopped()) return { ok: false, reason: 'Sync is stopped. Press "Start sync" first.' };
			const settings = await getSettings();
			if (!isConfigured(settings)) return { ok: false, reason: "Enter your settings first." };
			if (await isSyncRunning()) return { ok: false, reason: "A sync is already running." };
			if (!(await isOnline())) {
				await scheduleRetry("(Sync now button) No internet connection");
				return { ok: false, reason: "No internet connection — retrying automatically in 1 minute." };
			}
			const tab = await ensureSyncTab("Sync now button");
			return tab ? { ok: true } : { ok: false, reason: "Could not open the LinkedIn messaging tab." };
		}

		case "testConnection": {
			const settings = { ...(await getSettings()), ...(msg.settings || {}) };
			if (!settings.tabName || !settings.scriptUrl) return { status: "Enter both fields first." };
			const { status } = await postToSheet({ action: "ping", tab: settings.tabName }, settings);
			return { status };
		}

		case "resetHistory":
			await chrome.storage.local.remove(["lastSync", "sentHashes"]);
			await setStatus({ lastSummary: "Sync history cleared — the next sync re-checks your 50 most recent conversations." });
			log("Sync history cleared.");
			return { ok: true };

		case "settingsSaved":
			await ensureAlarm();
			await ensureSyncTab("settings saved");
			return { ok: true };

		// Popup "Stop sync": end a running sync now and pause all automatic syncing
		// (saved in storage.local, so it survives restarts) until "Start sync".
		case "stopSync": {
			await chrome.storage.local.set({ syncStopped: true });
			await chrome.alarms.clear(WAKE_ALARM);
			await chrome.alarms.clear(RETRY_ALARM);
			onStopCallbacks.forEach(cancel => cancel());
			const tabId = await getLocal("syncTabId", null);
			if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "stopSync" }).catch(() => {});
			await setStatus({ syncing: false, progress: "", lastError: "", lastSummary: 'Sync stopped. Press "Start sync" to turn it back on.' });
			log("Sync stopped from the popup — automatic syncing is paused until Start sync is pressed.");
			return { ok: true };
		}

		// Popup "Start sync": automatic syncing back on, and one sync right away.
		case "startSync": {
			await chrome.storage.local.remove("syncStopped");
			await setStatus({ lastSummary: "Sync started." });
			log("Sync started from the popup — automatic syncing is back on.");
			await ensureAlarm();
			const tab = await ensureSyncTab("Start sync button");
			return { ok: true, started: !!tab };
		}

		default:
			return { ok: false, error: `unknown message ${msg && msg.type}` };
	}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	handleMessage(msg, sender).then(sendResponse, err => {
		warn(`Error handling "${msg && msg.type}":`, err);
		sendResponse({ ok: false, error: String((err && err.message) || err) });
	});
	return true; // keep the channel open for the async answer
});
