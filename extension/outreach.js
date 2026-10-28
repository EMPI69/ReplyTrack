// LinkedIn API client. Injected by background.js ONLY into the extension's own worker
// tab (a LinkedIn tab in a minimized window), in the isolated world: LinkedIn's page
// scripts can't see this code, its variables or its messages. Nothing runs in your
// own LinkedIn tabs.
//
// background.js asks, one call at a time:
//   OR_PING                         → ready? signed in?
//   OR_ME                           → your own profile id
//   OR_PROFILE {identity}           → name, headline, profile URN, connection status
//   OR_INVITE  {pid, vanity, note, learned}  → connection request with the note
//   OR_VERIFY  {identity, pid, note}         → after sending: pending now? note visible?
//   OR_CONNECTIONS {start, count}            → your connections, most recently added first
//   OR_FIND_THREAD {pid}                     → your conversation with them, if LinkedIn says
//   OR_MESSAGE {pid, me, thread, text, learned} → ONE message (an Admin Reply) — never retried
// Each call is a same-origin fetch() from the logged-in LinkedIn page — your cookies,
// your CSRF token, your browser's own network stack — to LinkedIn's Voyager API, the
// same API LinkedIn's web app uses. No clicking, no DOM, no page loads.
(function () {
	const alive = () => {
		try {
			return !!chrome.runtime.id;
		} catch (e) {
			return false;
		}
	};
	if (globalThis.__orClient && globalThis.__orClient.alive()) return;
	globalThis.__orClient = { alive };

	// -------------------------------------------------------------------------
	// Network
	// -------------------------------------------------------------------------
	class SignedOut extends Error {}
	class RateLimited extends Error {}
	const csrf = () => {
		const m = document.cookie.match(/(?:^|;\s*)JSESSIONID=("?)([^";]+)\1/);
		return m ? m[2] : "";
	};
	const BLOCK_RE = /\/(authwall|checkpoint|login|uas\/login|signup)/;
	const json = t => {
		try {
			return JSON.parse(t);
		} catch (e) {
			return null;
		}
	};

	// headers: LinkedIn's own x-li-* headers (picked up by background.js) + per-call ones.
	async function request(url, { method = "GET", headers = {}, body, accept = "application/json", timeout = 25000 } = {}) {
		const token = csrf();
		if (!token) throw new SignedOut();
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), timeout);
		const t0 = performance.now();
		try {
			const r = await fetch(url, {
				method,
				headers: { accept, "csrf-token": token, ...headers },
				body: method === "GET" ? undefined : body,
				credentials: "include",
				signal: ctl.signal,
			});
			const text = await r.text();
			const ms = Math.round(performance.now() - t0);
			if (r.status === 401 || (r.redirected && BLOCK_RE.test(new URL(r.url).pathname))) throw new SignedOut();
			if (r.status === 403 && /CSRF check failed/i.test(text)) throw new SignedOut();
			if (r.status === 429 || r.status === 999) throw new RateLimited();
			return { status: r.status, text, ms };
		} catch (e) {
			if (e instanceof SignedOut || e instanceof RateLimited) throw e;
			return { status: 0, text: "", ms: Math.round(performance.now() - t0), error: e.name === "AbortError" ? "timed out" : e.message };
		} finally {
			clearTimeout(t);
		}
	}

	// LinkedIn's error text → short string for the log.
	function errText(r) {
		const j = json(r.text || "");
		const bits = j ? [j.code, j.data && j.data.code, j.message, j.data && j.data.message, j.exceptionClass].filter(x => typeof x === "string" && x) : [];
		const msg = bits.length ? [...new Set(bits)].join(" / ") : String(r.text || "").replace(/\s+/g, " ").slice(0, 160);
		return `HTTP ${r.status || r.error}${msg ? ` — ${msg.slice(0, 220)}` : ""}`;
	}

	// -------------------------------------------------------------------------
	// You
	// -------------------------------------------------------------------------
	async function me(headers) {
		const r = await request("/voyager/api/me", { headers: { "x-restli-protocol-version": "2.0.0", ...headers } });
		if (r.status !== 200) return { ok: false, error: `couldn't read your own profile (${errText(r)})` };
		const m = r.text.match(/urn:li:fs(?:d_profile|_miniProfile):(ACoA[\w-]+)/);
		return m ? { ok: true, pid: m[1] } : { ok: false, error: "couldn't find your profile id" };
	}

	// -------------------------------------------------------------------------
	// Profile + connection status (the same data the profile page's top card loads)
	// -------------------------------------------------------------------------
	const DECORATIONS = [
		"com.linkedin.voyager.dash.deco.identity.profile.TopCardComplete-138",
		"com.linkedin.voyager.dash.deco.identity.profile.TopCardSupplementary-120",
		"com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18",
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93",
	];
	let decoFirst = 0; // the first decoration that answered with a status is tried first next time
	const DIST = { DISTANCE_1: 1, DISTANCE_2: 2, DISTANCE_3: 3, OUT_OF_NETWORK: 4 };

	const strOf = (o, k) => {
		if (!o) return "";
		const v = o[k];
		if (typeof v === "string") return v;
		const ml = o["multiLocale" + k[0].toUpperCase() + k.slice(1)];
		return (ml && Object.values(ml).find(x => typeof x === "string")) || "";
	};

	function profileEntity(j, identity) {
		const els = (j && (j.elements || (j.data && j.data.elements))) || [];
		if (els[0] && typeof els[0] === "object" && els[0].entityUrn) return els[0];
		const inc = (j && Array.isArray(j.included) && j.included) || [];
		const profs = inc.filter(x => x && /fsd_profile:/.test(String(x.entityUrn || "")) && (x.firstName || x.publicIdentifier));
		return profs.find(x => String(x.publicIdentifier || "").toLowerCase() === String(identity).toLowerCase()) || profs[0] || null;
	}

	// memberRelationship.memberRelationshipUnion (or …Data):
	//   { self } | { connection } | { noConnection: { memberDistance, invitationUnion: { invitation | noInvitation } } }
	function relationOf(j, pid) {
		const found = [];
		const dists = [];
		const seen = new WeakSet();
		(function walk(o, d) {
			if (!o || typeof o !== "object" || d > 16 || seen.has(o)) return;
			seen.add(o);
			for (const k of ["memberRelationshipUnion", "memberRelationshipData", "memberRelationshipDataResolutionResult"]) {
				const u = o[k];
				if (u && typeof u === "object" && !Array.isArray(u)) found.push({ urn: String(o.entityUrn || ""), u });
			}
			for (const k of ["memberDistance", "distance"]) {
				const v = o[k];
				const s = typeof v === "string" ? v : v && typeof v.value === "string" ? v.value : "";
				if (DIST[s]) dists.push({ urn: String(o.entityUrn || ""), d: DIST[s] });
			}
			for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, d + 1);
		})(j, 0);
		const pick = arr => (pid && arr.find(x => x.urn.includes(pid))) || arr[0];
		const f = pick(found);
		if (f) {
			const u = f.u;
			if ("self" in u) return { known: true, self: true };
			if ("connection" in u) return { known: true, degree: 1 };
			const nc = u.noConnection;
			if (nc && typeof nc === "object") {
				const ds = typeof nc.memberDistance === "string" ? nc.memberDistance : nc.memberDistance && nc.memberDistance.value;
				const inv = nc.invitationUnion || nc.invitation || {};
				const invitation = inv.invitation || inv["*invitation"] || (typeof inv === "string" ? inv : null);
				let incoming = false;
				if (invitation && typeof invitation === "object") {
					const inviter = JSON.stringify(invitation.inviter || invitation["*inviter"] || invitation.inviterUrn || invitation.genericInviter || "");
					incoming = !!(pid && inviter.includes(pid));
				}
				return { known: true, degree: DIST[ds] || null, pending: !!invitation, incoming };
			}
		}
		const ds = pick(dists);
		if (ds) return ds.d === 1 ? { known: true, degree: 1 } : { known: "partial", degree: ds.d, pending: false };
		return { known: false };
	}

	async function profile(identity, headers, keepRaw = false) {
		const log = [];
		let base = null;
		const order = DECORATIONS.map((d, i) => i).sort((a, b) => (a === decoFirst ? -1 : b === decoFirst ? 1 : a - b));
		let lastStatus = 0;
		for (const i of order) {
			const deco = DECORATIONS[i];
			const short = deco.split(".").pop();
			const r = await request(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(identity)}&decorationId=${encodeURIComponent(deco)}`, {
				headers: { "x-restli-protocol-version": "2.0.0", ...headers },
			});
			lastStatus = r.status;
			if (r.status === 403 && /VoyagerUserVisibleException|can.t be accessed/i.test(r.text)) return { ok: false, unavailable: true, error: "this profile can't be viewed from your account", log };
			if (r.status !== 200) {
				log.push(`${short}: ${r.status || r.error}`);
				if (r.status === 0 || r.status === 403) break;
				continue;
			}
			const j = json(r.text);
			const el = profileEntity(j, identity);
			if (!el) {
				log.push(`${short}: 200 without profile`);
				continue;
			}
			const pid = (String(el.entityUrn || "").match(/fsd_profile:([\w-]+)/) || [])[1] || "";
			if (!base)
				base = {
					ok: true,
					pid,
					publicId: typeof el.publicIdentifier === "string" ? el.publicIdentifier : "",
					firstName: strOf(el, "firstName"),
					lastName: strOf(el, "lastName"),
					headline: strOf(el, "headline"),
				};
			const rel = relationOf(j, pid || base.pid);
			base.raw = r.text;
			log.push(`${short}: ${rel.known ? (rel.self ? "self" : rel.degree === 1 ? "connected" : rel.pending ? "request pending" : `degree ${rel.degree || "?"}`) : "no status in answer"}`);
			if (rel.known === true) {
				decoFirst = i;
				const { raw, ...out } = base;
				return { ...out, rel, log, ...(keepRaw ? { raw } : {}) };
			}
			if (rel.known === "partial") base.rel = rel;
		}
		if (base) {
			const { raw, ...out } = base;
			return { ...out, rel: base.rel || { known: false }, log, ...(keepRaw ? { raw } : {}) };
		}
		return { ok: false, unavailable: lastStatus === 404, error: lastStatus === 404 ? "profile not found" : `profile lookup failed (${log.join("; ") || "no answer"})`, log };
	}

	// -------------------------------------------------------------------------
	// Connection request with a note
	// -------------------------------------------------------------------------
	// Built-in request: LinkedIn's Voyager "create invitation" action. A request LEARNED
	// from your own manual send (background.js, via chrome.webRequest) is tried first.
	const INVITE_BUILTIN = {
		builtIn: true,
		method: "POST",
		url: "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2",
		body: '{"invitee":{"inviteeUnion":{"memberProfile":"urn:li:fsd_profile:{{PROFILE_ID}}"}},"customMessage":"{{NOTE}}"}',
		headers: { "content-type": "application/json; charset=UTF-8", "x-restli-protocol-version": "2.0.0" },
		accept: "application/vnd.linkedin.normalized+json+2.1",
	};

	const jsonInner = s => JSON.stringify(String(s)).slice(1, -1); // text for inside a JSON string
	const tracking = () => String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)));
	// Values go in through functions, so a "$" in a note or message stays a "$".
	const fillTpl = (s, v) =>
		String(s || "")
			.replace(/\{\{PROFILE_ID\}\}/g, () => v.pid || "")
			.replace(/\{\{VANITY\}\}/g, () => v.vanity || "")
			.replace(/\{\{NOTE\}\}/g, () => jsonInner(v.note || ""))
			.replace(/\{\{TEXT\}\}/g, () => jsonInner(v.text || ""))
			.replace(/\{\{ME\}\}/g, () => v.me || "")
			.replace(/\{\{THREAD\}\}/g, () => jsonInner(v.thread || ""))
			.replace(/\{\{UUID\}\}/g, () => crypto.randomUUID())
			.replace(/\{\{TRACKING\}\}/g, () => jsonInner(tracking()));

	// LinkedIn rejected the request's SHAPE (not the person / the account) → next variant.
	const REJECTED = new Set([400, 404, 405, 410, 415, 422]);
	const isOops = t => /"isOops"\s*:\s*true/.test(t || "");

	function classify(r) {
		const t = String(r.text || "");
		if (/CANT_RESEND_YET/i.test(t)) return "cantResend";
		if (/already.{0,30}(pending|invited|sent)|INVITATION_ALREADY|DUPLICATE_INVITATION|pendingInvitation/i.test(t)) return "pending";
		if (/ALREADY_CONNECTED|already (a )?connect/i.test(t)) return "connected";
		if (/custom.?message|CUSTOM_INVITE|personali[sz]ed|\bnote\b|upsell|premium/i.test(t) && r.status >= 400) return "noteRefused";
		if (/FUSE|weekly|limit|quota|too many|exceeded/i.test(t) && r.status >= 400) return "limit";
		if (/EMAIL_REQUIRED|email address/i.test(t) && r.status >= 400) return "emailRequired";
		if (REJECTED.has(r.status)) return "rejected";
		if (r.status === 403) return "forbidden";
		return "uncertain"; // timeout, network error, 5xx, error card: it may have gone through
	}

	// No note: the note field is left out of the request (not sent empty).
	const NOTE_FIELD = /^(customMessage|message|note|invitationMessage|inviteMessage)$/i;
	function dropNote(body) {
		const j = json(body);
		if (!j) return body;
		(function strip(o) {
			if (!o || typeof o !== "object") return;
			for (const k of Object.keys(o)) {
				if (NOTE_FIELD.test(k) && (o[k] === "" || o[k] === "{{NOTE}}")) delete o[k];
				else if (o[k] && typeof o[k] === "object") strip(o[k]);
			}
		})(j);
		return JSON.stringify(j);
	}

	async function invite({ pid, vanity, note, learned, headers }) {
		const log = [];
		const hasNote = !!String(note || "").trim();
		const list = (learned ? [learned] : []).concat(INVITE_BUILTIN);
		let learnedResult = null; // "ok" | "rejected" — background.js keeps score
		let last = null;
		for (const tpl of list) {
			const which = tpl.builtIn ? "built-in" : "learned";
			const h = tpl.builtIn ? { ...headers, ...tpl.headers } : { ...(tpl.headers || {}) };
			const r = await request(fillTpl(tpl.url, { pid, vanity }), {
				method: tpl.method || "POST",
				headers: h,
				body: hasNote ? fillTpl(tpl.body, { pid, vanity, note }) : fillTpl(dropNote(tpl.body), { pid, vanity, note: "" }),
				accept: tpl.accept || (tpl.headers && tpl.headers.accept) || "application/json",
			});
			if (r.status >= 200 && r.status < 300 && !isOops(r.text)) {
				if (!tpl.builtIn) learnedResult = "ok";
				log.push(`${which} request: ${r.status} in ${r.ms} ms`);
				return { ok: true, log, learnedResult };
			}
			let code = classify(r);
			if (code === "noteRefused" && !hasNote) code = REJECTED.has(r.status) ? "rejected" : "forbidden";
			log.push(`${which} request: ${errText(r)} → ${code}`);
			last = { ok: false, code, error: errText(r), log };
			if (code !== "rejected") {
				if (!tpl.builtIn && code !== "uncertain" && code !== "forbidden") learnedResult = "ok"; // a real answer about the person
				return { ...last, learnedResult };
			}
			if (!tpl.builtIn) learnedResult = "rejected";
		}
		return { ...(last || { ok: false, code: "failed", error: "no request variant available", log }), learnedResult };
	}

	// -------------------------------------------------------------------------
	// Check after sending: read the profile again — the request must now show as
	// pending — and look for the note in what LinkedIn returns.
	// -------------------------------------------------------------------------
	const squash = s => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
	function hasText(text, needle) {
		const n = squash(needle).slice(0, 60);
		if (!n || !text) return false;
		if (squash(text).includes(n)) return true;
		const j = json(text);
		if (!j) return false;
		let hit = false;
		const seen = new WeakSet();
		(function walk(o, d) {
			if (hit || !o || typeof o !== "object" || d > 30 || seen.has(o)) return;
			seen.add(o);
			for (const v of Object.values(o)) {
				if (typeof v === "string") {
					if (squash(v).includes(n)) return (hit = true);
				} else if (v && typeof v === "object") walk(v, d + 1);
			}
		})(j, 0);
		return hit;
	}
	async function verify({ identity, note, headers }) {
		const p = await profile(identity, headers, true);
		if (!p.ok) return { ok: false, error: p.error, log: p.log };
		const rel = p.rel || {};
		const out = { ok: true, known: rel.known === true, pending: !!(rel.pending && !rel.incoming), connected: rel.degree === 1, noteSeen: hasText(p.raw, note), where: "", log: p.log };
		if (out.noteSeen) out.where = "the profile";
		return out;
	}

	// -------------------------------------------------------------------------
	// Accepted check: your connections, most recently added first (the list on
	// My Network → Connections). → [{ publicId, pid, createdAt }]
	// -------------------------------------------------------------------------
	const CONNECTION_URLS = [
		"/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count={{COUNT}}&q=search&sortType=RECENTLY_ADDED&start={{START}}",
		"/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15&count={{COUNT}}&q=search&sortType=RECENTLY_ADDED&start={{START}}",
		"/voyager/api/relationships/connections?count={{COUNT}}&sortType=RECENTLY_ADDED&start={{START}}",
	];
	let connFirst = 0; // the first URL that answered is tried first next time

	// null = the answer has no connection data at all (try the next URL).
	function connectionsIn(j) {
		if (!j) return null;
		const names = new Map(); // profile urn → publicIdentifier
		const found = [];
		const seen = new WeakSet();
		(function walk(o, d) {
			if (!o || typeof o !== "object" || d > 20 || seen.has(o)) return;
			seen.add(o);
			if (typeof o.publicIdentifier === "string" && o.entityUrn) names.set(String(o.entityUrn), o.publicIdentifier);
			const member = o.connectedMember || o["*connectedMember"] || o.miniProfile || o["*miniProfile"];
			if ("createdAt" in o && member) found.push(o);
			for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, d + 1);
		})(j, 0);
		if (!found.length) {
			const els = j.elements || (j.data && j.data.elements);
			return Array.isArray(els) && !els.length ? [] : null;
		}
		return found
			.map(o => {
				let publicId = "";
				let urn = "";
				for (const x of [o.connectedMemberResolutionResult, o["*connectedMemberResolutionResult"], o.connectedMember, o["*connectedMember"], o.miniProfile, o["*miniProfile"]]) {
					if (x && typeof x === "object") {
						publicId = publicId || (typeof x.publicIdentifier === "string" ? x.publicIdentifier : "");
						urn = urn || String(x.entityUrn || "");
					} else if (typeof x === "string") urn = urn || x;
				}
				if (!publicId && urn) publicId = names.get(urn) || names.get(urn.replace("fs_miniProfile", "fsd_profile")) || names.get(urn.replace("fsd_profile", "fs_miniProfile")) || "";
				const pid = (urn.match(/(?:fsd_profile|fs_miniProfile):([\w-]+)/) || [])[1] || "";
				return { publicId, pid, createdAt: Number(o.createdAt) || 0 };
			})
			.filter(x => x.publicId || x.pid);
	}

	async function connections({ start = 0, count = 40, headers }) {
		const log = [];
		const order = CONNECTION_URLS.map((u, i) => i).sort((a, b) => (a === connFirst ? -1 : b === connFirst ? 1 : a - b));
		for (const i of order) {
			const url = CONNECTION_URLS[i].replace("{{COUNT}}", count).replace("{{START}}", start);
			const short = url.split("?")[0].split("/").slice(-2).join("/") + (url.match(/ConnectionListWithProfile-\d+/) || [""])[0];
			const r = await request(url, { headers: { "x-restli-protocol-version": "2.0.0", ...headers }, accept: "application/vnd.linkedin.normalized+json+2.1" });
			if (r.status !== 200) {
				log.push(`${short}: ${r.status || r.error}`);
				if (r.status === 0) break;
				continue;
			}
			const list = connectionsIn(json(r.text));
			if (!list) {
				log.push(`${short}: 200 without connections`);
				continue;
			}
			connFirst = i;
			return { ok: true, list, log };
		}
		return { ok: false, error: `couldn't read your connections list (${log.join("; ") || "no answer"})`, log };
	}

	// -------------------------------------------------------------------------
	// Admin Reply: ONE LinkedIn message to one connection. Never retried. Another
	// request shape is tried only when LinkedIn clearly rejected the previous one's
	// FORMAT (HTTP 400/404/405/410/415/422) — nothing was sent in that case.
	// -------------------------------------------------------------------------
	const MSG_URL = "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage";
	const MSG_HEADERS = { "content-type": "text/plain;charset=UTF-8", "x-restli-protocol-version": "2.0.0" };
	const MESSAGE_IN_THREAD = {
		builtIn: true,
		name: "built-in (conversation)",
		method: "POST",
		url: MSG_URL,
		body: '{"message":{"body":{"attributes":[],"text":"{{TEXT}}"},"renderContentUnions":[],"conversationUrn":"urn:li:msg_conversation:(urn:li:fsd_profile:{{ME}},{{THREAD}})","originToken":"{{UUID}}"},"mailboxUrn":"urn:li:fsd_profile:{{ME}}","trackingId":"{{TRACKING}}","dedupeByClientGeneratedToken":false}',
		headers: MSG_HEADERS,
		accept: "application/json",
	};
	const MESSAGE_NEW = {
		builtIn: true,
		name: "built-in (to the person)",
		method: "POST",
		url: MSG_URL,
		body: '{"message":{"body":{"attributes":[],"text":"{{TEXT}}"},"renderContentUnions":[],"originToken":"{{UUID}}"},"mailboxUrn":"urn:li:fsd_profile:{{ME}}","trackingId":"{{TRACKING}}","dedupeByClientGeneratedToken":false,"hostRecipientUrns":["urn:li:fsd_profile:{{PROFILE_ID}}"]}',
		headers: MSG_HEADERS,
		accept: "application/json",
	};

	// The conversation id (as in /messaging/thread/<id>/) in an answer, or "".
	const threadIn = t => {
		const s = String(t || "");
		const m = s.match(/msg_conversation:\(urn:li:fsd_profile:[\w-]+,([^)"\\]+)\)/) || s.match(/messagingThread:([^"\\,)\s]+)/) || s.match(/fs_conversation:([^"\\,)\s]+)/);
		return m ? m[1] : "";
	};

	function classifyMessage(r) {
		const t = String(r.text || "");
		if (r.status >= 400 && r.status < 500 && /NOT_CONNECTED|not.{0,20}connect|CANNOT_MESSAGE|cannot.{0,20}message|RECIPIENT|PERMISSION|not allowed/i.test(t)) return "notConnected";
		if (r.status >= 400 && /limit|quota|too many|exceeded/i.test(t)) return "limit";
		if (REJECTED.has(r.status)) return "rejected";
		if (r.status === 403) return "forbidden";
		return "uncertain"; // timeout, network error, 5xx, error card: it may have gone through
	}

	async function message({ pid, me, thread, text, learned, headers }) {
		const log = [];
		const list = [];
		if (learned && (thread || !/\{\{THREAD\}\}/.test(learned.url + learned.body)) && (pid || !/\{\{PROFILE_ID\}\}/.test(learned.url + learned.body))) list.push(learned);
		if (thread) list.push(MESSAGE_IN_THREAD);
		list.push(MESSAGE_NEW);
		let learnedResult = null; // "ok" | "rejected" — background.js keeps score
		let last = null;
		for (const tpl of list) {
			const which = tpl.builtIn ? tpl.name : "learned";
			const v = { pid, me, thread, text };
			const h = tpl.builtIn ? { ...headers, ...tpl.headers } : { ...(tpl.headers || {}) };
			const r = await request(fillTpl(tpl.url, v), {
				method: tpl.method || "POST",
				headers: h,
				body: fillTpl(tpl.body, v),
				accept: tpl.accept || (tpl.headers && tpl.headers.accept) || "application/json",
			});
			if (r.status >= 200 && r.status < 300 && !isOops(r.text)) {
				if (!tpl.builtIn) learnedResult = "ok";
				log.push(`${which} message: ${r.status} in ${r.ms} ms`);
				return { ok: true, thread: threadIn(r.text) || thread || "", log, learnedResult };
			}
			const code = classifyMessage(r);
			log.push(`${which} message: ${errText(r)} → ${code}`);
			last = { ok: false, code, error: errText(r), log };
			if (code !== "rejected") {
				if (!tpl.builtIn && code !== "uncertain" && code !== "forbidden") learnedResult = "ok";
				return { ...last, learnedResult };
			}
			if (!tpl.builtIn) learnedResult = "rejected";
		}
		return { ...(last || { ok: false, code: "rejected", error: "no request variant available", log }), learnedResult };
	}

	// Your conversation with them, by LinkedIn's (older) participants lookup. "" if not found.
	async function findThread({ pid, headers }) {
		const r = await request(`/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=participants&recipients=List(${encodeURIComponent(pid)})`, {
			headers: { "x-restli-protocol-version": "2.0.0", ...headers },
			accept: "application/vnd.linkedin.normalized+json+2.1",
		});
		if (r.status !== 200) return { ok: false, thread: "", error: errText(r) };
		return { ok: true, thread: threadIn(r.text) };
	}

	// -------------------------------------------------------------------------
	// Messages from background.js
	// -------------------------------------------------------------------------
	const guard = p =>
		p.catch(e => {
			if (e instanceof SignedOut) return { ok: false, fatal: true, kind: "signedOut", error: "LinkedIn signed you out." };
			if (e instanceof RateLimited) return { ok: false, fatal: true, kind: "rate", error: "LinkedIn answered “too many requests” (HTTP 429)." };
			return { ok: false, error: `Unexpected error: ${e.message}` };
		});

	chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
		switch (msg.type) {
			case "OR_PING":
				sendResponse({ ok: true, path: location.pathname, signedIn: !!csrf() });
				return;
			case "OR_ME":
				guard(me(msg.headers || {})).then(sendResponse);
				return true;
			case "OR_PROFILE":
				guard(profile(msg.identity, msg.headers || {})).then(sendResponse);
				return true;
			case "OR_INVITE":
				guard(invite(msg)).then(sendResponse);
				return true;
			case "OR_VERIFY":
				guard(verify(msg)).then(sendResponse);
				return true;
			case "OR_CONNECTIONS":
				guard(connections(msg)).then(sendResponse);
				return true;
			case "OR_FIND_THREAD":
				guard(findThread(msg)).then(sendResponse);
				return true;
			case "OR_MESSAGE":
				guard(message(msg)).then(sendResponse);
				return true;
		}
	});
})();
