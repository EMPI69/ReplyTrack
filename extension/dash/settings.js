// Settings: Connection (storage.sync), Outreach — the note and the pace (storage.local
// "orSettings", saved as you type) — and Data (reset sync history, import sent history).
// https://script.google.com/macros/s/<id>/exec  or  …/a/macros/<domain>/s/<id>/exec
const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;

function show(el, text, kind) {
	$(el).textContent = text;
	$(el).className = `msg ${kind || ""}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function readConnection() {
	return {
		tabName: $("tabName").value.trim(),
		scriptUrl: $("scriptUrl").value.trim().replace(/\/+$/, "").replace(/\?.*$/, ""),
		secretKey: $("secretKey").value.trim(),
		useGoogleLogin: $("useGoogleLogin").checked,
	};
}

function validate(s) {
	if (!s.tabName) return "Enter your tab name.";
	if (!s.scriptUrl) return "Enter your web app URL.";
	if (/\/dev$/.test(s.scriptUrl)) return "That's a test (/dev) URL. Use the deployment URL that ends in /exec.";
	if (!URL_RE.test(s.scriptUrl)) return "That doesn't look like an Apps Script web app URL. It should start with https://script.google.com/ and end with /exec.";
	if (!s.secretKey) return "Enter the secret key (the same as SECRET_KEY in your Code.gs).";
	return "";
}

async function testConnection(settings) {
	show("msg", "Testing…");
	const r = (await send({ type: "testConnection", settings })) || { ok: false, error: "no answer" };
	if (!r.ok) {
		const e = String(r.error || "");
		if (e === "tab not found") show("msg", `Your sheet has no tab called “${settings.tabName}”. Check the spelling (spaces count).`, "bad");
		else if (e === "wrong key") show("msg", "The secret key doesn't match SECRET_KEY in your Code.gs.", "bad");
		else if (/SECRET_KEY/.test(e)) show("msg", `Your Code.gs isn't ready: ${e}. Set it, save, and deploy a new version.`, "bad");
		else show("msg", `Problem: ${e}`, "bad");
		return false;
	}
	const values = r.statusValues || [];
	const lines = [`Connected. Found the tab “${r.tab}” (${r.rows} rows) with all the columns.`];
	lines.push(values.length ? `Outreach Status choices: ${values.join(" | ")}` : "⚠ No Outreach Status dropdown found — the status can't be updated.");
	for (const v of ["Sent", "Replied"]) if (values.length && !values.some(x => S.norm(x) === S.norm(v))) lines.push(`⚠ “${v}” isn't in the dropdown, so it's never written.`);
	for (const p of r.problems || []) lines.push(`⚠ ${p}`);
	lines.push(`Dates and reply times use the time zone ${r.timeZone}.`);
	show("msg", lines.join("\n"), lines.some(l => l.startsWith("⚠")) ? "bad" : "ok");
	return true;
}

$("showKey").addEventListener("click", () => {
	const hidden = $("secretKey").type === "password";
	$("secretKey").type = hidden ? "text" : "password";
	$("showKey").textContent = hidden ? "Hide" : "Show";
});

// Save (in the card, or in the "unsaved changes" bar): check, store, test, tell the service worker.
let saving = false;
async function saveConnection() {
	if (saving) return;
	const s = readConnection();
	const problem = validate(s);
	if (problem) {
		barProblem = problem;
		renderSaveBar();
		return show("msg", problem, "bad");
	}
	saving = true;
	$("save").disabled = $("saveBarSave").disabled = true;
	try {
		await chrome.storage.sync.set(s);
		cfg = { ...cfg, ...s }; // the bar goes now; storage.onChanged follows
		$("scriptUrl").value = s.scriptUrl;
		renderSaveBar();
		const ok = await testConnection(s);
		await send({ type: "settingsSaved" });
		if (ok) $("msg").textContent += "\n\nSaved. A pinned LinkedIn messaging tab now syncs replies every 20 minutes.";
	} catch (e) {
		show("msg", `Could not save: ${e.message || e}`, "bad");
	} finally {
		saving = false;
		$("save").disabled = $("saveBarSave").disabled = false;
	}
}
$("save").addEventListener("click", saveConnection);

// "You have unsaved changes": the Connection fields differ from what's saved. (The Outreach
// settings save as you type, so they're never unsaved.)
let barProblem = "";
const CONNECTION_FIELDS = ["tabName", "scriptUrl", "secretKey"];
function connectionDirty() {
	const now = readConnection();
	const saved = { tabName: String(cfg.tabName || "").trim(), scriptUrl: String(cfg.scriptUrl || "").trim(), secretKey: String(cfg.secretKey || "").trim(), useGoogleLogin: !!cfg.useGoogleLogin };
	return Object.keys(saved).some(k => now[k] !== saved[k]);
}
function renderSaveBar() {
	const dirty = connectionDirty();
	if (!dirty) barProblem = "";
	$("saveBar").classList.toggle("hidden", !dirty);
	$("saveBar").classList.toggle("bad", !!barProblem);
	$("saveBarText").textContent = barProblem || "You have unsaved changes";
}
for (const id of CONNECTION_FIELDS)
	$(id).addEventListener("input", () => {
		barProblem = "";
		renderSaveBar();
	});
$("useGoogleLogin").addEventListener("change", () => {
	barProblem = "";
	renderSaveBar();
});
$("saveBarSave").addEventListener("click", () => {
	if (tab !== "settings") showTab("settings"); // the test result shows in the Connection card
	$("connCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
	saveConnection();
});
$("discard").addEventListener("click", () => {
	for (const id of CONNECTION_FIELDS) $(id).value = cfg[id] || "";
	$("useGoogleLogin").checked = !!cfg.useGoogleLogin;
	barProblem = "";
	show("msg", "", "");
	renderSaveBar();
});

$("test").addEventListener("click", async () => {
	const s = readConnection();
	const problem = validate(s);
	if (problem) return show("msg", problem, "bad");
	$("test").disabled = true;
	try {
		await testConnection(s);
	} catch (e) {
		show("msg", `Test failed: ${e.message || e}`, "bad");
	} finally {
		$("test").disabled = false;
	}
});

// The fields are filled once (and again if the settings change elsewhere) — never while you type.
let connectionShown = "";
onRender(() => {
	const key = JSON.stringify(cfg);
	if (key !== connectionShown) {
		connectionShown = key;
		for (const id of CONNECTION_FIELDS) if (document.activeElement !== $(id)) $(id).value = cfg[id] || "";
		$("useGoogleLogin").checked = !!cfg.useGoogleLogin;
	}
	renderSaveBar();
});

// ---------------------------------------------------------------------------
// Outreach: note + pace (saved on every change)
// ---------------------------------------------------------------------------
const NUMS = ["readMin", "readMax", "pauseMin", "pauseMax", "breakEvery", "dailyCap"];

async function saveOutreach(patch) {
	const next = { ...orSettings(), ...patch };
	if (next.readMax < next.readMin) next.readMax = next.readMin;
	if (next.pauseMax < next.pauseMin) next.pauseMax = next.pauseMin;
	await chrome.storage.local.set({ orSettings: next });
}
function readOutreach() {
	const p = {};
	for (const id of NUMS) {
		const v = Number($(id).value);
		p[id] = Number.isFinite(v) && v >= 0 ? v : S.DEFAULTS[id];
	}
	for (const id of ["readMin", "readMax", "pauseMin", "pauseMax"]) p[id] = Math.max(1, p[id]);
	p.breakEvery = Math.round(p.breakEvery);
	p.dailyCap = Math.round(p.dailyCap);
	p.noteMode = (document.querySelector('input[name="noteMode"]:checked') || {}).value || "column";
	p.noteText = $("noteText").value;
	return p;
}
const pick = mode => (document.querySelector(`input[name="noteMode"][value="${mode}"]`).checked = true);
onRender(() => {
	if (tab !== "settings") return;
	const s0 = orSettings();
	for (const id of NUMS) if (document.activeElement !== $(id)) $(id).value = s0[id];
	if (!document.activeElement || document.activeElement.name !== "noteMode") pick(["typed", "none"].includes(s0.noteMode) ? s0.noteMode : "column");
	if (document.activeElement !== $("noteText")) $("noteText").value = s0.noteText || "";
	const typed = String(s0.noteText || "").trim();
	$("typedStatus").textContent = typed ? `${S.chars(typed)} / ${S.NOTE_LIMIT} characters as typed (placeholders are filled per row).` : "";
	$("typedStatus").className = `hint ${S.chars(typed) > S.NOTE_LIMIT ? "err" : ""}`;
	$("setRate").textContent = `≈ ${Math.round(3600 / S.secondsPerRequest(s0))} requests / hour`;
});
NUMS.forEach(id => $(id).addEventListener("change", () => saveOutreach(readOutreach())));
document.querySelectorAll('input[name="noteMode"]').forEach(r => r.addEventListener("change", () => saveOutreach(readOutreach())));
let textTimer = null;
$("noteText").addEventListener("focus", () => {
	if (!document.querySelector('input[name="noteMode"][value="typed"]').checked) {
		pick("typed");
		saveOutreach(readOutreach());
	}
});
$("noteText").addEventListener("input", () => {
	pick("typed");
	clearTimeout(textTimer);
	textTimer = setTimeout(() => saveOutreach(readOutreach()), 350);
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
$("reset").addEventListener("click", async () => {
	if (!confirm("Reset sync history? The next sync will re-check your 50 most recent conversations.")) return;
	await send({ type: "resetHistory" });
	alert("Sync history cleared.");
});

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async e => {
	const f = e.target.files[0];
	e.target.value = "";
	if (!f) return;
	try {
		const text = await f.text();
		const entries = {};
		if (/^\s*\{/.test(text)) {
			// { "h:<key>": time } from the old extension's storage
			const j = JSON.parse(text);
			for (const [k, v] of Object.entries(j)) if (/^h:/.test(k)) entries[k] = Number(v) || 0;
		} else {
			// The old extension's Export CSV: rows whose requestStatus is "Sent"
			const rows = S.parseCSV(text);
			const head = rows[0] || [];
			const sc = S.findCol(head, "requestStatus");
			const at = S.findCol(head, "sentAt");
			if (sc < 0) throw new Error("That CSV has no requestStatus column — is it the old extension's Export CSV?");
			for (const r of rows.slice(1)) {
				if (S.norm(r[sc]) !== "sent") continue;
				const id = r.map(S.idFromCell).find(Boolean);
				if (id) entries["h:" + id.toLowerCase()] = Date.parse(r[at]) || 0; // 0 = sent, date unknown
			}
		}
		const res = await send({ type: "OR_IMPORT", entries });
		if (!res || !res.ok) throw new Error((res && res.error) || "no answer");
		show("importMsg", `Imported ${res.n} people (${res.added} new). They never get another request from ReplyTrack; a waiting row for one of them is marked “Sent” with the original date at the next run.`, "ok");
	} catch (err) {
		show("importMsg", `Couldn't import: ${err.message || err}`, "bad");
	}
});
