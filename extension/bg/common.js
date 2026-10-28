// Small helpers shared by every part of the service worker (loaded first by background.js).
const S = globalThis.ORShared;

const DAY_MS = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (Math.max(a, b) - a);
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const startOfDay = (t = Date.now()) => {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};
// Monday 00:00 of this week (local time).
const startOfWeek = (t = Date.now()) => {
	const d = new Date(startOfDay(t));
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
};

async function getLocal(key, fallback) {
	const r = await chrome.storage.local.get(key);
	return r[key] === undefined ? fallback : r[key];
}

// For comparing message texts: spacing, line breaks and upper/lower case don't matter.
const normText = s => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

// "https://www.linkedin.com/in/Jane-Doe/?trk=x" → "jane-doe" — the same rule as
// profileKey_() in Code.gs, so the extension and the sheet agree on who is who.
function profileKey(url) {
	let s = String(url || "").trim();
	for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
		try {
			s = decodeURIComponent(s);
		} catch (e) {
			break;
		}
	}
	const m = s.match(/linkedin\.com\/(?:mwlite\/)?in\/([^/?#\s"']+)/i) || s.match(/linkedin\.com\/sales\/(?:lead|people)\/(AC[wo]AA[\w-]+)/i);
	return m ? m[1].trim().toLowerCase() : "";
}

// Short, stable hash (cyrb53).
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

// Log to the console with a prefix, and keep the lines (popup / page "Details").
function makeLog(prefix, key, max = 400, days = 7) {
	let chain = Promise.resolve();
	return function (level, msg) {
		(level === "error" ? console.error : level === "warn" ? console.warn : console.log)(prefix, msg);
		chain = chain
			.then(async () => {
				const r = await chrome.storage.local.get(key);
				const old = Date.now() - days * DAY_MS;
				await chrome.storage.local.set({ [key]: (r[key] || []).filter(e => e.t > old).concat({ t: Date.now(), level, msg }).slice(-max) });
			})
			.catch(() => {});
		return chain;
	};
}
const orLog = makeLog("[Outreach]", "orLog");
const rsLog = makeLog("[ReplySync]", "rsLog", 300);

// The dashboard's "Recent activity": { t, kind, name, text? } — kind: request (sent),
// accepted, reply (captured), admin (Admin Reply sent), chat (message sent as a chat).
let activityChain = Promise.resolve();
function addActivity(kind, name, text) {
	activityChain = activityChain
		.then(async () => {
			const list = await getLocal("rtActivity", []);
			list.push({ t: Date.now(), kind, name: String(name || ""), ...(text ? { text: String(text).slice(0, 200) } : {}) });
			await chrome.storage.local.set({ rtActivity: list.slice(-100) });
		})
		.catch(() => {});
	return activityChain;
}

// Chrome stops an idle service worker after 30 s; this keeps it awake while something
// long runs. Returns the function that ends it.
function keepAwake(beat) {
	const id = setInterval(() => {
		chrome.runtime.getPlatformInfo().catch(() => {});
		if (beat) beat();
	}, 20000);
	return () => clearInterval(id);
}

// "LinkedIn logged out — sign in again" banner. Cleared when LinkedIn signs you in again.
const LOGGED_OUT_KEY = "rtLoggedOut";
const setLoggedOut = where => chrome.storage.local.set({ [LOGGED_OUT_KEY]: { at: Date.now(), where: String(where || "") } }).catch(() => {});
const clearLoggedOut = () => chrome.storage.local.remove(LOGGED_OUT_KEY).catch(() => {});
