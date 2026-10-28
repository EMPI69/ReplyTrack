// Shared helpers — loaded by the pages, the popup and the service worker.
// Pure functions: the sheet's columns, profile-URL detection, the note, defaults.
(function (root) {
	const NOTE_LIMIT = 300; // LinkedIn Premium: notes up to 300 characters

	// Headers in row 1 of each member's sheet (matched ignoring case and extra spaces).
	const COLUMNS = {
		profile: "LinkedIn Profile",
		message: "Personalized Message",
		status: "Outreach Status",
		sentDate: "Sent Date",
		notes: "Response / Notes",
		admin: "Admin Reply",
		name: "Name",
		member: "Team Member", // read only — the dashboard's "Welcome back, <name>"
	};
	// Outreach Status values a connection request may be sent from. Any other value
	// (Sent, Drafted, Replied, Meeting Booked, …) means: never touch the row.
	const SENDABLE = ["", "not started"];

	// Settings (one object in storage.local["orSettings"])
	const DEFAULTS = {
		noteMode: "column", // "column" (the row's Personalized Message) | "typed" | "none" (request without a note)
		noteText: "", // one note for everyone (placeholders allowed)
		readMin: 4, // wait on the profile before sending (s)
		readMax: 10,
		pauseMin: 5, // pause before the next profile, after a request (s)
		pauseMax: 10,
		breakEvery: 25, // 1–3 min break after about this many requests (0 = off)
		dailyCap: 500, // auto-stop after this many requests a day (0 = off)
	};
	// Fixed timings (seconds), shown on the page
	const SKIP_PAUSE = [3, 6]; // after a profile visit that sent nothing
	const BREAK_S = [60, 180];
	const REQUEST_S = 1.5; // the two API calls themselves, roughly

	// Average seconds per row that gets a request (for the estimate).
	function secondsPerRequest(st) {
		const avg = (a, b) => (Number(a) + Math.max(Number(a), Number(b))) / 2;
		const brk = st.breakEvery > 0 ? (BREAK_S[0] + BREAK_S[1]) / 2 / st.breakEvery : 0;
		return avg(st.readMin, st.readMax) + avg(st.pauseMin, st.pauseMax) + REQUEST_S + brk;
	}

	// -------------------------------------------------------------------------
	// CSV (RFC 4180: quoted fields, "" escapes, line breaks inside quotes) — for
	// "Import sent history" (the old extension's Export CSV) and Export CSV.
	// -------------------------------------------------------------------------
	function sniffDelimiter(text) {
		const first = text.slice(0, 5000).split(/\r?\n/)[0] || "";
		let best = ",";
		let bestN = -1;
		for (const d of [",", ";", "\t", "|"]) {
			let n = 0;
			let q = false;
			for (const ch of first) {
				if (ch === '"') q = !q;
				else if (ch === d && !q) n++;
			}
			if (n > bestN) {
				best = d;
				bestN = n;
			}
		}
		return best;
	}

	function parseCSV(text) {
		text = String(text || "").replace(/^﻿/, "");
		const d = sniffDelimiter(text);
		const rows = [];
		let row = [];
		let f = "";
		let q = false;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (q) {
				if (c === '"') {
					if (text[i + 1] === '"') {
						f += '"';
						i++;
					} else q = false;
				} else f += c;
			} else if (c === '"') q = true;
			else if (c === d) {
				row.push(f);
				f = "";
			} else if (c === "\n" || c === "\r") {
				if (c === "\r" && text[i + 1] === "\n") i++;
				row.push(f);
				f = "";
				if (row.some(x => x !== "")) rows.push(row);
				row = [];
			} else f += c;
		}
		row.push(f);
		if (row.some(x => x !== "")) rows.push(row);
		return rows;
	}

	function csvCell(v) {
		let s = String(v == null ? "" : v).slice(0, 32000);
		if (/^[=+\-@]/.test(s)) s = " " + s; // Excel would treat it as a formula
		return `"${s.replace(/"/g, '""')}"`;
	}

	// -------------------------------------------------------------------------
	// Profile ids: public vanity (/in/<name>) or Sales Nav member id (ACwAA…)
	// -------------------------------------------------------------------------
	const IN_RE = /linkedin\.com\/in\/([^/?#\s,;"']+)/i;
	const SN_RE = /linkedin\.com\/sales\/(?:lead|people)\/(AC[wo]AA[\w-]+)/i;
	function idFromCell(cell) {
		const s = String(cell || "");
		const m = s.match(IN_RE) || s.match(SN_RE);
		if (!m) return "";
		try {
			return decodeURIComponent(m[1]);
		} catch (e) {
			return m[1];
		}
	}
	const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
	const findCol = (header, name) => (norm(name) ? header.findIndex(h => norm(h) === norm(name)) : -1);
	const isSendable = status => SENDABLE.includes(norm(status));

	// -------------------------------------------------------------------------
	// Placeholders: {Name}, {Company Name}, {firstName}… (also {{ }}). Every column of
	// the sheet works. Keys match ignoring case, spaces and punctuation:
	// {first name} = {firstName} = {FIRST_NAME}. A placeholder that can't be filled is
	// never sent — the row is skipped.
	// -------------------------------------------------------------------------
	const PH_RE = /\{\{?\s*([A-Za-z][\w .\-]{0,40}?)\s*\}\}?/g;
	const keyOf = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
	const PROFILE_KEYS = ["firstName", "lastName", "fullName", "headline"];

	function rowVars(header, row) {
		const v = {};
		header.forEach((h, i) => {
			const k = keyOf(h);
			if (k && !(k in v && v[k])) v[k] = String((row && row[i]) || "").trim();
		});
		if (!v.fullname && v.name) v.fullname = v.name;
		if (!v.company && v.companyname) v.company = v.companyname;
		if (!v.companyname && v.company) v.companyname = v.company;
		return v;
	}

	// Values from the sheet win; the profile fills what the sheet lacks.
	function withProfile(vars, prof) {
		const v = { ...vars };
		const p = prof || {};
		const add = (k, val) => {
			if (!v[k] && val) v[k] = String(val).trim();
		};
		add("firstname", p.firstName);
		add("lastname", p.lastName);
		add("fullname", [p.firstName, p.lastName].filter(Boolean).join(" "));
		add("name", [p.firstName, p.lastName].filter(Boolean).join(" "));
		add("headline", p.headline);
		if (!v.firstname && v.fullname) v.firstname = v.fullname.split(/\s+/)[0];
		return v;
	}

	// Before the profile is looked up: profile placeholders show as «firstName».
	function markerVars(header, row) {
		const v = rowVars(header, row);
		for (const k of PROFILE_KEYS) if (!v[keyOf(k)]) v[keyOf(k)] = `«${k}»`;
		if (!v.name) v.name = "«fullName»";
		return v;
	}

	function fill(tpl, vars) {
		const missing = [];
		const empty = [];
		const text = String(tpl || "").replace(PH_RE, (m, name) => {
			const k = keyOf(name);
			if (!(k in vars)) {
				missing.push(name.trim());
				return m;
			}
			const val = vars[k];
			if (val == null || String(val).trim() === "") {
				empty.push(name.trim());
				return m;
			}
			return String(val).trim();
		});
		return { text: text.replace(/\r\n/g, "\n").trim(), missing, empty };
	}

	const chars = s => [...String(s || "")].length;

	// Is the note set up? → { col } | { typed: true } | { none: true } | { error }
	function noteSetup(st, header) {
		if (st.noteMode === "none") return { none: true };
		if (st.noteMode === "typed") return String(st.noteText || "").trim() ? { typed: true } : { error: "Type your note in Settings first." };
		const col = findCol(header || [], COLUMNS.message);
		if (col < 0) return { error: `There's no “${COLUMNS.message}” column in your sheet.` };
		return { col };
	}

	// The note for one row. prof = the looked-up profile, or null for a check before the
	// lookup (profile placeholders then count as filled, and the length isn't judged).
	// → { text } | { skip: reason }   (text "" = request without a note)
	function buildNote(st, header, row, prof) {
		const ns = noteSetup(st, header);
		if (ns.error) return { skip: ns.error };
		if (ns.none) return { text: "", none: true };
		const tpl = ns.typed ? st.noteText : String((row && row[ns.col]) || "");
		if (!tpl.trim()) return { skip: `the ${COLUMNS.message} is empty for this row` };
		const f = fill(tpl, prof ? withProfile(rowVars(header, row), prof) : markerVars(header, row));
		if (f.missing.length) return { skip: `the note has {${f.missing[0]}}, which isn't a column in the sheet` };
		if (f.empty.length) return { skip: `{${f.empty[0]}} is empty for this row` };
		const n = chars(f.text);
		if (prof && n > NOTE_LIMIT) return { skip: `the note is ${n} characters (LinkedIn allows ${NOTE_LIMIT})` };
		return { text: f.text, approxLong: !prof && n > NOTE_LIMIT ? n : 0 };
	}

	// "1 h 20 min", "25 min", "40 s"
	function fmtLong(sec) {
		sec = Math.max(0, Math.round(sec));
		if (sec < 90) return `${Math.max(1, sec)} s`;
		const m = Math.round(sec / 60);
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
	}
	const clock = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

	// Time left. run: orRun; todo: rows waiting; capLeft: requests still allowed today.
	// While running, the pace so far (≥ 3 rows) beats the settings-based guess.
	function estimate({ run, todo, st, capLeft = Infinity, now = Date.now() }) {
		const per = secondsPerRequest(st);
		if (run && run.active && run.job !== "test") {
			const left = Math.max(0, (run.target || 0) - (run.processed || 0));
			if (!left) return "";
			const done = run.processed || 0;
			const perRow = done >= 3 && run.startedAt ? (now - run.startedAt) / 1000 / done : per;
			const secs = left * perRow;
			let t = `About ${fmtLong(secs)} left (${left.toLocaleString()} row${left === 1 ? "" : "s"}) — done around ${clock(now + secs * 1000)}.`;
			if (run.job === "send" && capLeft < left) t += ` It auto-stops at today's limit after about ${capLeft.toLocaleString()} more request${capLeft === 1 ? "" : "s"}.`;
			return t;
		}
		if (!todo) return "";
		let t = `Estimated time: about ${fmtLong(todo * per)} for ${todo.toLocaleString()} row${todo === 1 ? "" : "s"} if each gets a request; skipped rows go faster.`;
		if (capLeft < todo) t += ` The daily auto-stop pauses it after ${capLeft.toLocaleString()} request${capLeft === 1 ? "" : "s"} today.`;
		return t;
	}

	root.ORShared = {
		fmtLong,
		estimate,
		NOTE_LIMIT,
		COLUMNS,
		SENDABLE,
		DEFAULTS,
		SKIP_PAUSE,
		BREAK_S,
		secondsPerRequest,
		parseCSV,
		csvCell,
		idFromCell,
		norm,
		findCol,
		isSendable,
		keyOf,
		rowVars,
		withProfile,
		markerVars,
		fill,
		chars,
		noteSetup,
		buildNote,
		PROFILE_KEYS,
	};
})(globalThis);
