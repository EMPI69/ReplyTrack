// ReplyTrack — content script for https://www.linkedin.com/messaging/*
// Runs once per page load. In the pinned sync tab only, it walks the
// conversation list newest-first, opens each conversation, collects the
// messages the OTHER person sent, and hands them to background.js.
// In the extension's own minimized LinkedIn tab it only answers "read this
// conversation" (for an Admin Reply: already sent there? did it arrive?).
(() => {
	"use strict";

	// =========================================================================
	// CONFIG — everything that depends on LinkedIn's page layout lives here.
	//
	// LinkedIn changes its HTML often. When syncing breaks, open
	// linkedin.com/messaging, right-click the part that's no longer found →
	// Inspect, and add a selector that matches it to the FRONT of the right
	// list below. Each list is tried in order; the first selector that
	// matches something wins, so keep the old ones as fallbacks.
	//
	// Prefer stable hooks: aria-labels, href patterns ("/in/", "/messaging/thread/"),
	// data-* attributes and the long, readable "msg-…" class names. Avoid short
	// generated classes like "ember123" or "t-14 xyz12".
	// =========================================================================
	const CONFIG = {
		// ---- Pace and limits ------------------------------------------------
		FIRST_RUN_LIMIT: 50, // conversations checked on the very first sync
		MAX_PER_SYNC: 200, // safety cap for later syncs
		DELAY_MS: [2000, 5000], // random pause between opening conversations (human pace)
		LIST_TIMEOUT_MS: 45000, // wait this long for the conversation list to appear
		THREAD_TIMEOUT_MS: 20000, // wait this long for a clicked conversation to open
		LOAD_MORE_TIMEOUT_MS: 10000, // wait this long for older conversations after scrolling
		SETTLE_MS: 1500, // extra wait after a conversation opens, for late messages
		POLL_MS: 500, // how often to re-check the page while waiting
		LAST_SYNC_MARGIN_MS: 10 * 60 * 1000, // re-check 10 min before the last sync (overlap is harmless)

		SELECTORS: {
			// ---- Left column: the list of conversations ---------------------
			// The <ul> (or container) that holds the conversation rows.
			conversationList: [
				"ul.msg-conversations-container__conversations-list",
				'ul[class*="conversations-list"]',
				'[aria-label*="conversation list" i] ul',
				".msg-conversations-container ul",
			],
			// One row (one conversation) inside that list.
			conversationItem: [
				"li.msg-conversation-listitem",
				'li[class*="msg-conversation-listitem"]',
				"li.msg-conversations-container__convo-item",
				'li[class*="convo-item"]',
				":scope > li",
			],
			// The thing to click inside a row to open the conversation.
			clickTarget: [
				'a[href*="/messaging/thread/"]',
				".msg-conversation-listitem__link",
				".msg-conversation-card__content--selectable",
				'[class*="conversation-card__content"]',
				'[role="button"]',
				'[tabindex="0"]',
			],
			// The participant name(s) in a row.
			itemName: [
				".msg-conversation-listitem__participant-names",
				".msg-conversation-card__participant-names",
				'[class*="participant-names"]',
				"h3",
			],
			// The "last activity" time in a row ("3:45 PM", "Mon", "Oct 12", "Oct 12, 2023").
			itemTime: [
				"time.msg-conversation-listitem__time-stamp",
				"time.msg-conversation-card__time-stamp",
				"time",
				'[class*="time-stamp"]',
			],
			// The preview of the last message in a row.
			itemSnippet: [".msg-conversation-card__message-snippet", '[class*="message-snippet"]'],
			// Present only on GROUP conversation rows (several profile photos).
			// Groups are also detected after opening (more than 2 senders).
			itemGroupMarker: ['[class*="facepile-grid--group"]', '[class*="group-entity"]'],
			// Labels on promotional rows; their text is checked against PATTERNS.sponsoredText.
			itemSponsoredLabel: [".msg-conversation-card__pill", '[class*="__pill"]', '[class*="sponsored" i]', '[class*="spinmail" i]'],
			// "Load more conversations" button, if LinkedIn shows one instead of infinite scroll.
			loadMoreButton: ['button[class*="load-more"]', 'button[aria-label*="load more" i]'],

			// ---- Right side: the open conversation --------------------------
			// The panel that shows the open conversation.
			threadContainer: [".msg-convo-wrapper", ".msg-thread", "main"],
			// The bar at the top of the open conversation (name + profile link).
			threadTitleBar: [".msg-title-bar", '[class*="msg-title-bar"]', ".msg-overlay-bubble-header"],
			// The link to the other person's profile in that bar.
			threadProfileLink: [
				"a.msg-thread__link-to-profile",
				'.msg-title-bar a[href*="/in/"]',
				'.msg-entity-lockup a[href*="/in/"]',
				'[class*="title-bar"] a[href*="/in/"]',
			],
			// The other person's name in that bar.
			threadName: ["#thread-detail-jump-target", ".msg-entity-lockup__entity-title", '[class*="entity-title"]', '[class*="title-bar"] h2'],
			// Small text under the name (groups show e.g. "3 participants").
			threadSubtitle: [".msg-entity-lockup__entity-info", '[class*="entity-info"]', '[class*="subtitle"]'],
			// Marks a sponsored / promotional InMail thread.
			threadSponsoredMarker: ['[class*="spinmail" i]', '[class*="sponsored" i]'],
			// Intro card at the top of a thread — often links to the vanity URL.
			profileCardLink: ['.msg-s-profile-card a[href*="/in/"]', '[class*="profile-card"] a[href*="/in/"]'],

			// ---- Messages inside the open conversation ----------------------
			// The list holding all messages.
			messageList: ["ul.msg-s-message-list-content", ".msg-s-message-list", '[class*="msg-s-message-list"]'],
			// One entry in that list (a message, maybe with a sender header above it).
			messageEvent: ["li.msg-s-message-list__event", 'li[class*="message-list__event"]', ":scope > li"],
			// One message inside an entry.
			messageItem: [".msg-s-event-listitem", "[data-event-urn]"],
			// The text of one message.
			messageBody: [".msg-s-event-listitem__body", '[class*="event-listitem__body"]', '[class*="message-body"]'],
			// Present on messages the OTHER person sent (yours don't have it).
			// If LinkedIn drops this, the sender name/link below is used instead.
			otherPersonMessage: [".msg-s-event-listitem--other", '[class*="event-listitem--other"]'],
			// Sender header shown above a run of messages from one person.
			senderLink: [
				"a.msg-s-message-group__profile-link",
				'.msg-s-message-group__meta a[href*="/in/"]',
				'[class*="message-group__meta"] a[href*="/in/"]',
				'a[href*="/in/"]',
			],
			senderName: [".msg-s-message-group__name", '[class*="message-group__name"]'],
			// Screen-reader text like "Jane Doe sent the following message at 3:45 PM".
			a11yText: [".visually-hidden", ".a11y-text", '[class*="a11y"]'],
			// Date divider between days in the message list ("Today", "Yesterday",
			// "Monday", "Oct 12", "Oct 12, 2025"). Gives the DATE of the messages below it.
			dateHeading: ["time.msg-s-message-list__time-heading", ".msg-s-message-list__time-heading", '[class*="time-heading"]'],
			// Time shown next to the sender's name ("11:42 PM"). Gives the TIME of
			// that message and the ones after it, until the next one. Date dividers
			// are never used as message times. If neither can be read, the time
			// the extension captured the message is used instead.
			messageTime: ["time.msg-s-message-group__timestamp", '[class*="message-group__timestamp"]', ".msg-s-message-group__meta time", "time"],

			// ---- Logged out ---------------------------------------------------
			loginForm: ['input[name="session_key"]', 'form[action*="login-submit"]', "form.login__form"],
		},

		PATTERNS: {
			threadId: /\/messaging\/thread\/([^/?#]+)/,
			sponsoredText: /\b(sponsored|promoted|inmail)\b/i,
			groupSubtitle: /\b\d+\s+(participants|members|people)\b/i,
			a11ySender: /^(.+?)\s+sent the following messages?\b/i,
			clock: /(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?\s*m\b\.?)?/i, // "11:42 PM", "23:42"
			loginUrl: /linkedin\.com\/(login|uas\/|checkpoint|authwall|signup|m\/login)/i,
		},
	};
	// =========================================================================

	const S = CONFIG.SELECTORS;
	const P = CONFIG.PATTERNS;
	const log = (...a) => console.log("[ReplySync]", ...a);
	const warn = (...a) => console.warn("[ReplySync]", ...a);

	class Abort extends Error {} // stop the whole sync quietly
	class LoggedOut extends Abort {}
	class Stopped extends Abort {} // "Stop sync" was pressed in the popup

	// Set when background.js says "Stop sync" was pressed. From then on every
	// step (waits, opening a conversation, sending) ends the sync instead.
	let stopRequested = false;
	chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
		if (!msg) return;
		if (msg.type === "stopSync") stopRequested = true;
		if (msg.type === "RT_PING") sendResponse({ ok: true, path: location.pathname, login: isLoginPage() });
		if (msg.type === "RT_READ_THREAD") {
			readForCheck().then(sendResponse, e => sendResponse({ ok: false, error: e.message || String(e) }));
			return true;
		}
	});

	// ---- DOM helpers ---------------------------------------------------------
	function safeAll(root, sel) {
		try {
			return [...root.querySelectorAll(sel)];
		} catch (e) {
			warn(`Bad selector in CONFIG: ${sel}`);
			return [];
		}
	}
	// All matches of the first selector in the list that matches anything.
	function qsa(root, sels) {
		if (!root) return [];
		for (const sel of sels) {
			const found = safeAll(root, sel);
			if (found.length) return found;
		}
		return [];
	}
	// First element (passing the optional test) of the first selector that has one.
	function qs(root, sels, test) {
		if (!root) return null;
		for (const sel of sels) {
			const el = safeAll(root, sel).find(x => !test || test(x));
			if (el) return el;
		}
		return null;
	}
	function matchesAny(el, sels) {
		return sels.some(sel => {
			try {
				return el.matches(sel);
			} catch (e) {
				return false;
			}
		});
	}
	const textOf = el => (el ? String(el.innerText || el.textContent || "").replace(/[ \t ]+/g, " ").trim() : "");
	const firstLine = s => String(s || "").split("\n").map(x => x.trim()).find(Boolean) || "";
	const messageText = el =>
		String(el.innerText || el.textContent || "")
			.replace(/ /g, " ")
			.split("\n")
			.map(l => l.trim())
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	const nameKey = s =>
		String(s || "")
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	// Loose match: list rows can truncate names, headers can add pronouns.
	function namesMatch(a, b) {
		const ka = nameKey(a);
		const kb = nameKey(b);
		if (!ka || !kb) return true;
		const n = Math.min(ka.length, kb.length, 12);
		return ka.slice(0, n) === kb.slice(0, n);
	}

	// ---- Profile links -------------------------------------------------------
	function slugOf(url) {
		const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s"']+)/i);
		return m ? m[1] : "";
	}
	const isMemberId = slug => /^AC[ow]AA[A-Za-z0-9_-]{6,}$/.test(String(slug || ""));
	function personKey(url) {
		const slug = slugOf(url);
		try {
			return decodeURIComponent(slug).toLowerCase();
		} catch (e) {
			return slug.toLowerCase();
		}
	}
	function vanityFromHtml(html) {
		const m =
			html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)/i) ||
			html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*linkedin\.com\/in\/([^"'/?#]+)/i);
		return m && !isMemberId(m[1]) ? m[1] : "";
	}

	// ---- Talking to background.js -------------------------------------------
	const STOPPED_TEXT = "Sync was stopped from the extension popup — not opening any more conversations or sending anything to the sheet.";
	async function send(msg) {
		if (!chrome.runtime || !chrome.runtime.id) throw new Abort("The extension was reloaded — this page will sync on its next load.");
		if (stopRequested) throw new Stopped(STOPPED_TEXT);
		try {
			const r = await chrome.runtime.sendMessage(msg);
			if (r && r.stopped) {
				stopRequested = true;
				throw new Stopped(r.reason ? `Not syncing: ${r.reason}.` : STOPPED_TEXT);
			}
			return r;
		} catch (e) {
			if (e instanceof Stopped) throw e;
			if (/context invalidated/i.test(e.message || "")) throw new Abort("The extension was reloaded — this page will sync on its next load.");
			warn(`Message "${msg.type}" to background failed:`, e.message || e);
			return null;
		}
	}

	// Waits via the background worker: Chrome throttles timers in background
	// tabs, which would turn a 3-second pause into up to a minute.
	async function sleep(ms) {
		const t0 = Date.now();
		const r = await send({ type: "sleep", ms });
		const left = ms - (Date.now() - t0);
		if ((!r || !r.ok) && left > 0) await new Promise(res => setTimeout(res, left));
	}
	const randomBetween = ([min, max]) => min + Math.random() * (max - min);
	const humanDelay = () => sleep(randomBetween(CONFIG.DELAY_MS));

	// Polls fn() until it returns something truthy, or gives up after timeoutMs.
	async function waitFor(fn, timeoutMs, what) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			let v = null;
			try {
				v = fn();
			} catch (e) {
				v = null;
			}
			if (v) return v;
			if (Date.now() >= end) {
				if (what) warn(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}.`);
				return null;
			}
			await sleep(CONFIG.POLL_MS);
		}
	}

	const isLoginPage = () => P.loginUrl.test(location.href) || !!qs(document, S.loginForm);

	// ---- "Last activity" times in the list -----------------------------------
	// Returns { low, high } (ms) — the time range the label could mean — or null.
	const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
	const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
	function parseTime(raw, now = new Date()) {
		const t = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
		if (!t) return null;
		const MIN = 6e4;
		const HOUR = 36e5;
		const DAY = 864e5;
		const nowMs = now.getTime();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const wholeDay = start => ({ low: start, high: start + DAY });
		let m;

		if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
			// datetime="2025-10-12T14:03:00" style attribute
			const d = Date.parse(raw);
			if (!isNaN(d)) return /t\d/.test(t) ? { low: d, high: d + MIN } : { low: d - DAY, high: d + DAY };
		}
		if (/^(now|just now|moments? ago)$/.test(t)) return { low: nowMs - 5 * MIN, high: nowMs };
		if ((m = t.match(/^(\d{1,2})[:.](\d{2})\s*([ap])\.?\s*m?\.?$/))) {
			let h = Number(m[1]) % 12;
			if (m[3] === "p") h += 12;
			const at = today + h * HOUR + Number(m[2]) * MIN;
			return { low: at, high: at + MIN };
		}
		if ((m = t.match(/^(\d{1,2})[:.](\d{2})$/))) {
			const at = today + Number(m[1]) * HOUR + Number(m[2]) * MIN;
			return { low: at, high: at + MIN };
		}
		if ((m = t.match(/^(\d+)\s*([a-z]+)(?: ago)?$/))) {
			const n = Number(m[1]);
			const u = m[2];
			const unit = /^mo/.test(u) ? 30 * DAY : /^s/.test(u) ? 1000 : /^m/.test(u) ? MIN : /^h/.test(u) ? HOUR : /^d/.test(u) ? DAY : /^w/.test(u) ? 7 * DAY : /^y/.test(u) ? 365 * DAY : 0;
			if (unit) return { low: nowMs - (n + 1) * unit, high: nowMs - n * unit + MIN };
		}
		if (t === "today") return wholeDay(today);
		if (t === "yesterday") return wholeDay(today - DAY);
		if (/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/.test(t)) {
			const back = (now.getDay() - WEEKDAYS[t.slice(0, 3)] + 7) % 7 || 7;
			return wholeDay(today - back * DAY);
		}
		const monthDay = (mon, day, year) => {
			const mi = MONTHS[mon.slice(0, 3)];
			if (mi === undefined) return null;
			let start = new Date(year ? Number(year) : now.getFullYear(), mi, Number(day)).getTime();
			if (!year && start > today) start = new Date(now.getFullYear() - 1, mi, Number(day)).getTime();
			return wholeDay(start);
		};
		if ((m = t.match(/^([a-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))?$/))) return monthDay(m[1], m[2], m[3]);
		if ((m = t.match(/^(\d{1,2}) ([a-z]{3,9})\.?(?:,? (\d{4}))?$/))) return monthDay(m[2], m[1], m[3]);
		const d = Date.parse(raw);
		return isNaN(d) ? null : wholeDay(d);
	}

	// ---- When a message was sent ---------------------------------------------
	// "11:42 PM" / "23:42" / "…sent the following message at 11:42 PM" -> { h, m } or null.
	function parseClock(text) {
		const m = String(text || "").match(P.clock);
		if (!m) return null;
		let h = Number(m[1]);
		const min = Number(m[2]);
		if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
		return h <= 23 && min <= 59 ? { h, m: min } : null;
	}

	// A date divider -> the Date (midnight, local time) it stands for, or null.
	function parseDay(el) {
		const attr = el.getAttribute("datetime") || "";
		const iso = attr.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
		const r = parseTime(textOf(el));
		if (!r) return null;
		const d = new Date(r.low);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate());
	}

	// The sent time shown inside root (not in a message's text, not a date divider).
	// -> { exact: ms } when LinkedIn gives a full timestamp, { h, m } for a clock time, or null.
	function timeIn(root, bodies) {
		const notInBody = x => !bodies.some(b => b.contains(x));
		const el = qs(root, S.messageTime, x => notInBody(x) && !matchesAny(x, S.dateHeading));
		if (el) {
			const attr = el.getAttribute("datetime") || "";
			if (/^\d{4}-\d{2}-\d{2}T\d/.test(attr) && !isNaN(Date.parse(attr))) return { exact: Date.parse(attr) };
			const c = parseClock(textOf(el));
			if (c) return c;
		}
		for (const sel of S.a11yText) {
			const hit = safeAll(root, sel).find(x => notInBody(x) && P.a11ySender.test(textOf(x)));
			const c = hit && parseClock(textOf(hit).replace(P.a11ySender, ""));
			if (c) return c;
		}
		return null;
	}

	// Date divider + clock time -> ms, or null if either is missing. A time in
	// the future means something was misread, so it's treated as unreadable.
	function sentAtOf(day, tm, now) {
		let ms = null;
		if (tm && tm.exact) ms = tm.exact;
		else if (day && tm) ms = new Date(day.getFullYear(), day.getMonth(), day.getDate(), tm.h, tm.m).getTime();
		return ms && ms <= now + 5 * 60000 ? ms : null;
	}

	// ---- Conversation list ---------------------------------------------------
	const getList = () => qs(document, S.conversationList);
	const getCards = () => qsa(getList(), S.conversationItem);

	function readCard(el) {
		const link = el.querySelector('a[href*="/messaging/thread/"]');
		const href = link ? link.href : "";
		const idMatch = href.match(P.threadId);
		const name = firstLine(textOf(qs(el, S.itemName)));
		const timeEl = qs(el, S.itemTime);
		const timeText = timeEl ? timeEl.getAttribute("datetime") || textOf(timeEl) : "";
		const snippet = textOf(qs(el, S.itemSnippet));
		const img = el.querySelector("img[src]");
		const isSponsored =
			S.itemSponsoredLabel.some(sel => safeAll(el, sel).some(x => P.sponsoredText.test(textOf(x)) || /sponsored|spinmail/i.test(String(x.className)))) ||
			/^(sponsored|inmail)\b/i.test(snippet);
		return {
			key: (idMatch && idMatch[1]) || (name ? `${name}|${img ? img.src : ""}` : ""),
			name,
			threadId: idMatch ? idMatch[1] : "",
			timeText,
			range: parseTime(timeText),
			isGroup: !!qs(el, S.itemGroupMarker),
			isSponsored,
		};
	}

	function nextCard(done) {
		for (const el of getCards()) {
			const info = readCard(el);
			if (info.key && !done.has(info.key)) return { el, info };
		}
		return null;
	}

	function scrollableAncestor(el) {
		for (let n = el; n && n !== document.body; n = n.parentElement) {
			const s = getComputedStyle(n);
			if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 5) return n;
		}
		return document.scrollingElement;
	}

	// Scrolls the list to make LinkedIn load older conversations. true = more appeared.
	async function loadMore() {
		const before = getCards().length;
		const list = getList();
		if (!list) return false;
		const btn = qs(document, S.loadMoreButton);
		if (btn) btn.click();
		const cards = getCards();
		if (cards.length) cards[cards.length - 1].scrollIntoView({ block: "end" });
		const scroller = scrollableAncestor(list);
		if (scroller) {
			scroller.scrollTop = scroller.scrollHeight;
			scroller.dispatchEvent(new Event("scroll"));
		}
		const more = await waitFor(() => getCards().length > before, CONFIG.LOAD_MORE_TIMEOUT_MS);
		log(more ? `Loaded more conversations (${getCards().length} in list).` : "No more conversations loaded.");
		return !!more;
	}

	// ---- The open conversation ----------------------------------------------
	function readHeader() {
		const root = qs(document, S.threadContainer) || document;
		const bar = qs(root, S.threadTitleBar) || root;
		const link = qs(bar, S.threadProfileLink, a => /linkedin\.com\/in\//i.test(a.href || ""));
		const name = firstLine(textOf(qs(bar, S.threadName))) || (link ? firstLine(textOf(link)) : "");
		return { root, bar, href: link ? link.href : "", name, subtitle: textOf(qs(bar, S.threadSubtitle)) };
	}

	function senderOf(ev) {
		const bodies = S.messageBody.flatMap(sel => safeAll(ev, sel));
		const notInBody = el => !bodies.some(b => b.contains(el));
		const link = qs(ev, S.senderLink, a => notInBody(a) && /linkedin\.com\/in\//i.test(a.href || ""));
		const nameEl = qs(ev, S.senderName, notInBody);
		let name = nameEl ? firstLine(textOf(nameEl)) : "";
		if (!name) {
			for (const sel of S.a11yText) {
				const hit = safeAll(ev, sel).map(x => textOf(x).match(P.a11ySender)).find(Boolean);
				if (hit) {
					name = hit[1].trim();
					break;
				}
			}
		}
		return link || name ? { href: link ? link.href : "", name } : null;
	}

	function readThread() {
		const header = readHeader();
		const list = qs(header.root, S.messageList) || qs(document, S.messageList);
		const t = {
			name: header.name,
			profileHref: header.href,
			threadId: (location.pathname.match(P.threadId) || [])[1] || "",
			listFound: !!list,
			messages: [],
			mine: [], // messages YOU sent — never "their reply"; used to find your last Admin Reply
			otherHrefs: new Map(), // personKey -> href, for senders of "their" messages
			isGroup: P.groupSubtitle.test(header.subtitle),
			isSponsored: !!(qs(list, S.threadSponsoredMarker) || (header.bar !== header.root && qs(header.bar, S.threadSponsoredMarker))),
			vanityHint: "",
		};
		const card = qs(header.root, S.profileCardLink, a => slugOf(a.href) && !isMemberId(slugOf(a.href)));
		if (card) t.vanityHint = card.href;
		if (!list) return t;

		const partnerKey = personKey(header.href);
		const partnerName = nameKey(header.name);
		const senderHrefs = new Set();
		const senderNames = new Set();
		let sender = { href: "", name: "" };
		const capturedAt = Date.now();
		let day = null; // from the latest date divider
		let time = null; // from the latest sender header
		let seq = 0; // position in the conversation, oldest first (theirs and yours)

		for (const ev of qsa(list, S.messageEvent)) {
			const heading = matchesAny(ev, S.dateHeading) ? ev : qs(ev, S.dateHeading);
			const headingDay = heading && parseDay(heading);
			if (headingDay) {
				day = headingDay;
				time = null; // a new day — the previous message's time no longer applies
			}
			const s = senderOf(ev);
			if (s) {
				sender = s;
				if (s.href) senderHrefs.add(personKey(s.href));
				if (s.name) senderNames.add(nameKey(s.name));
			}
			const bodies = S.messageBody.flatMap(sel => safeAll(ev, sel));
			time = timeIn(ev, bodies) || time;
			let items = qsa(ev, S.messageItem);
			if (!items.length) items = [ev];
			for (const item of items) {
				if (items.length > 1) time = timeIn(item, bodies) || time;
				const body = qs(item, S.messageBody);
				if (!body) continue;
				const text = messageText(body);
				if (!text) continue;
				const i = seq++;
				const fromOther =
					matchesAny(item, S.otherPersonMessage) ||
					!!qs(item, S.otherPersonMessage) ||
					!!(partnerKey && sender.href && personKey(sender.href) === partnerKey) ||
					!!(partnerName && sender.name && namesMatch(sender.name, header.name));
				if (!fromOther) {
					t.mine.push({ text, i });
					continue;
				}
				const sentAt = sentAtOf(day, time, capturedAt);
				t.messages.push({ text, sentAt: sentAt || capturedAt, timeFromLinkedIn: !!sentAt, i });
				if (sender.href) t.otherHrefs.set(personKey(sender.href), sender.href);
			}
		}
		// A 1:1 conversation has at most 2 senders: you and them.
		if (senderHrefs.size > 2 || senderNames.size > 2 || t.otherHrefs.size > 1) t.isGroup = true;
		return t;
	}

	// The header and the message list sometimes update at different moments.
	// If their messages carry a sender link that isn't the header's person, the
	// page is mid-switch — don't attribute anything yet.
	function looksMixedUp(t) {
		if (!t.profileHref || !t.otherHrefs.size) return false;
		const header = slugOf(t.profileHref);
		const comparable = [...t.otherHrefs.values()].filter(h => isMemberId(slugOf(h)) === isMemberId(header));
		return comparable.length > 0 && !comparable.some(h => personKey(h) === personKey(t.profileHref));
	}

	async function openConversation(cardEl, info) {
		const before = location.pathname;
		const target = qs(cardEl, S.clickTarget) || cardEl;
		target.scrollIntoView({ block: "nearest" });
		target.click();
		const clickedAt = Date.now();
		const ready = await waitFor(
			() => {
				if (!qs(document, S.messageList)) return false;
				if (info.name && !namesMatch(info.name, readHeader().name)) return false;
				const path = location.pathname;
				// URL changed, or it already shows this thread, or (no URL change, e.g. it
				// was already open) the right name has been showing for a few seconds.
				return path !== before || (info.threadId && path.includes(info.threadId)) || Date.now() - clickedAt > 3000;
			},
			CONFIG.THREAD_TIMEOUT_MS,
			`conversation "${info.name}" to open`
		);
		if (!ready) return false;
		await sleep(CONFIG.SETTLE_MS);
		return true;
	}

	// ACoAA… link -> vanity URL. Background first (cached); then this page's own
	// same-origin request; then a vanity link shown inside the thread.
	async function resolveProfile(href, vanityHint) {
		const r = await send({ type: "resolveProfile", url: href });
		if (r && r.profileUrl) return r.profileUrl;
		if (r && r.loggedOut) {
			await send({ type: "loggedOut", where: "profile lookup" });
			throw new LoggedOut("LinkedIn is logged out.");
		}
		const slug = slugOf(href);
		if (isMemberId(slug)) {
			try {
				const res = await fetch(`https://www.linkedin.com/in/${slug}/`, { credentials: "include" });
				let vanity = slugOf(res.url);
				if (!vanity || isMemberId(vanity)) vanity = vanityFromHtml(await res.text());
				if (vanity && !isMemberId(vanity)) {
					const profileUrl = `https://www.linkedin.com/in/${vanity}`;
					await send({ type: "cacheVanity", memberId: slug, profileUrl });
					return profileUrl;
				}
			} catch (e) {
				warn("Page-side profile lookup failed:", e.message || e);
			}
		}
		if (vanityHint) {
			log(`Using the profile link shown in the conversation: ${vanityHint}`);
			return `https://www.linkedin.com/in/${slugOf(vanityHint)}`;
		}
		return null;
	}

	// → { outcome: "sent" | "nothing" | "skipped" | "error" | "fatal", why, sent, selectorProblem }
	async function processConversation(cardEl, info) {
		if (!(await openConversation(cardEl, info))) return { outcome: "error", why: "the conversation did not open" };

		let t = readThread();
		if (looksMixedUp(t)) {
			await sleep(2000);
			t = readThread();
			if (looksMixedUp(t)) return { outcome: "error", why: "the page was still switching conversations" };
		}
		if (!t.listFound) return { outcome: "error", why: "message list not found — check CONFIG.SELECTORS.messageList", selectorProblem: true };
		if (t.isGroup) return { outcome: "skipped", why: "group conversation" };
		if (t.isSponsored) return { outcome: "skipped", why: "sponsored / InMail" };

		const href = t.profileHref || (t.otherHrefs.size === 1 ? [...t.otherHrefs.values()][0] : "") || t.vanityHint;
		if (!href) return { outcome: "skipped", why: "no profile link found (company page or LinkedIn system message?)", selectorProblem: true };
		if (!t.messages.length) return { outcome: "nothing", why: "no messages from them" };
		const untimed = t.messages.filter(m => !m.timeFromLinkedIn).length;
		if (untimed) warn(`Couldn't read when ${untimed} message(s) were sent — using the capture time. Check CONFIG.SELECTORS.dateHeading / messageTime.`);

		const profileUrl = await resolveProfile(href, t.vanityHint);
		if (!profileUrl) return { outcome: "error", why: `could not turn ${href} into a vanity profile URL` };

		const r = await send({
			type: "postConversation",
			conversationId: t.threadId || info.threadId || `p:${personKey(profileUrl)}`,
			threadId: t.threadId || info.threadId || "",
			profileUrl,
			name: t.name || info.name,
			messages: t.messages,
			mine: t.mine,
		});
		if (!r) return { outcome: "error", why: "the background script did not answer" };
		if (r.fatal) return { outcome: "fatal", why: r.status };
		if (r.error) return { outcome: "error", why: r.status };
		return { outcome: r.sent ? "sent" : "nothing", sent: r.sent || 0, why: r.status };
	}

	// ---- The sync ------------------------------------------------------------
	async function runSync(lastSync) {
		const startedAt = Date.now();
		const limit = lastSync ? CONFIG.MAX_PER_SYNC : CONFIG.FIRST_RUN_LIMIT;
		const stats = { opened: 0, sent: 0, nothing: 0, skipped: 0, failed: 0, selectorProblems: 0 };
		const failed = []; // card infos of conversations that failed (kept in the next sync's window)
		let error = "";
		let keepWindow = false; // true = don't move lastSync forward

		log(lastSync ? `Sync started. Checking conversations active since ${new Date(lastSync).toLocaleString()}.` : `First sync — checking the ${limit} most recent conversations.`);
		await send({ type: "syncStarted" });

		try {
			const listReady = await waitFor(() => getCards().length > 0, CONFIG.LIST_TIMEOUT_MS, "the conversation list");
			if (!listReady) {
				if (isLoginPage()) throw new LoggedOut("LinkedIn is logged out.");
				throw new Error("The conversation list did not load. If LinkedIn changed its layout, update CONFIG.SELECTORS.conversationList / conversationItem.");
			}
			await sleep(CONFIG.SETTLE_MS);

			const done = new Set();
			while (stats.opened < limit) {
				const next = nextCard(done);
				if (!next) {
					if (await loadMore()) continue;
					break;
				}
				const { el, info } = next;
				done.add(info.key);
				const label = info.name || info.key;

				if (info.isSponsored) {
					stats.skipped++;
					log(`Skip "${label}": sponsored / InMail.`);
					continue;
				}
				if (lastSync && info.range && info.range.high < lastSync - CONFIG.LAST_SYNC_MARGIN_MS) {
					log(`Reached "${label}" (${info.timeText}) — older than the last sync, stopping.`);
					break;
				}
				if (info.isGroup) {
					stats.skipped++;
					log(`Skip "${label}": group conversation.`);
					continue;
				}

				if (stats.opened > 0) await humanDelay();
				if (stopRequested) throw new Stopped(STOPPED_TEXT);
				stats.opened++;
				await send({ type: "syncProgress", text: `Checking conversation ${stats.opened}: ${label}` });

				let r;
				try {
					r = await processConversation(el, info);
				} catch (e) {
					if (e instanceof Abort) throw e;
					r = { outcome: "error", why: e.message || String(e) };
				}
				if (r.selectorProblem) stats.selectorProblems++;

				if (r.outcome === "sent") {
					stats.sent += r.sent;
					log(`"${label}": sent ${r.sent} new message(s) — sheet says "${r.why}".`);
				} else if (r.outcome === "nothing") {
					stats.nothing++;
					log(`"${label}": nothing new (${r.why}).`);
				} else if (r.outcome === "skipped") {
					stats.skipped++;
					log(`Skip "${label}": ${r.why}.`);
				} else if (r.outcome === "fatal") {
					error = `Google Sheet: ${r.why}`;
					keepWindow = true;
					warn(`Stopping: ${error}`);
					break;
				} else {
					stats.failed++;
					failed.push(info);
					warn(`"${label}" failed: ${r.why}. Continuing with the next conversation.`);
				}
			}

			// Every conversation opened, and none had a findable profile link / message
			// list: LinkedIn's layout probably changed. Don't advance — fix CONFIG first.
			if (!error && stats.opened >= 3 && stats.selectorProblems === stats.opened) {
				error = "Couldn't read any conversation — LinkedIn's layout may have changed (see CONFIG in content.js).";
				keepWindow = true;
				warn(error);
			}
		} catch (e) {
			keepWindow = true;
			if (e instanceof LoggedOut) {
				error = "LinkedIn is logged out.";
				await send({ type: "loggedOut", where: location.href }).catch(() => {});
			} else if (e instanceof Stopped) {
				// Not reported as finished, so the "last sync" time stays where it was.
				log(`${e.message} (checked ${stats.opened} conversation(s), sent ${stats.sent} message(s) before stopping)`);
				return;
			} else if (e instanceof Abort) {
				error = e.message;
				warn(error);
				return; // extension reloaded — can't report back
			} else {
				error = e.message || String(e);
				console.error("[ReplySync] Sync error:", e);
			}
		}

		// Next sync looks back to when this one started — or further, to cover
		// any conversation that failed this time.
		let nextLastSync = keepWindow ? null : startedAt;
		if (nextLastSync) {
			for (const f of failed) {
				if (!f.range) {
					nextLastSync = lastSync; // unknown time: keep the old window
					break;
				}
				nextLastSync = Math.min(nextLastSync, f.range.low - 60000);
			}
		}

		const summary = `Checked ${stats.opened} conversation(s) · sent ${stats.sent} new message(s) · ${stats.nothing} with nothing new · ${stats.skipped} skipped · ${stats.failed} failed`;
		log(`Sync finished. ${summary}${error ? ` · ERROR: ${error}` : ""}`);
		await send({ type: "syncFinished", sent: stats.sent, failed: stats.failed, summary, error, nextLastSync }).catch(() => {});
	}

	// ---- Admin Reply check (the extension's own minimized tab) ---------------
	// background.js opened one conversation here. Wait for it, then report who it's
	// with and the messages YOU sent in it. Reads only: nothing is clicked or typed.
	// Waits use this page's own timers (not "sleep" via the background, which is
	// refused while the reply sync is stopped).
	async function readForCheck() {
		const pause = ms => new Promise(res => setTimeout(res, ms));
		const loaded = () => {
			const list = qs(document, S.messageList);
			return !!list && qsa(list, S.messageEvent).length > 0;
		};
		const end = Date.now() + CONFIG.LIST_TIMEOUT_MS;
		while (!loaded() && Date.now() < end) {
			if (isLoginPage()) return { ok: false, loggedOut: true };
			await pause(CONFIG.POLL_MS);
		}
		if (!loaded()) return { ok: false, error: "the conversation did not load" };
		await pause(CONFIG.SETTLE_MS * 2); // late messages
		const t = readThread();
		log(`Read conversation ${t.threadId || "?"} with "${t.name}" for an Admin Reply check: ${t.mine.length} message(s) from you, ${t.messages.length} from them.`);
		return {
			ok: true,
			threadId: t.threadId,
			profileHref: t.profileHref,
			name: t.name,
			otherHrefs: [...t.otherHrefs.values()],
			isGroup: t.isGroup,
			mine: t.mine.map(m => m.text),
			theirs: t.messages.length,
		};
	}

	async function main() {
		if (window.__replySyncStarted) return;
		window.__replySyncStarted = true;
		try {
			log("Loaded on", location.href);
			if (isLoginPage()) {
				await send({ type: "loggedOut", where: location.href });
				return;
			}
			const go = await send({ type: "shouldSync" });
			if (!go || !go.ok) {
				log(`Not syncing in this tab: ${(go && (go.reason || go.error)) || "no answer from background"}`);
				return;
			}
			await runSync(go.lastSync || null);
		} catch (e) {
			if (e instanceof Stopped) log(e.message);
			else if (e instanceof Abort) warn(e.message);
			else console.error("[ReplySync] Unexpected error:", e);
		}
	}

	main();
})();
