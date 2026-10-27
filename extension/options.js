// ReplyTrack — options page: tab name + Apps Script URL (chrome.storage.sync).
const $ = id => document.getElementById(id);
// https://script.google.com/macros/s/<id>/exec  or  …/a/macros/<domain>/s/<id>/exec
const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;

function show(text, kind) {
	$("msg").textContent = text;
	$("msg").className = kind || "";
}

function readForm() {
	return {
		tabName: $("tabName").value.trim(),
		scriptUrl: $("scriptUrl").value.trim().replace(/\/+$/, "").replace(/\?.*$/, ""),
		useGoogleLogin: $("useGoogleLogin").checked,
	};
}

function validate(s) {
	if (!s.tabName) return "Enter your tab name.";
	if (!s.scriptUrl) return "Enter the Apps Script web app URL.";
	if (/\/dev$/.test(s.scriptUrl)) return "That's a test (/dev) URL. Use the deployment URL that ends in /exec.";
	if (!URL_RE.test(s.scriptUrl)) return "That doesn't look like an Apps Script web app URL. It should start with https://script.google.com/ and end with /exec.";
	return "";
}

async function load() {
	const s = await chrome.storage.sync.get({ tabName: "", scriptUrl: "", useGoogleLogin: false });
	$("tabName").value = s.tabName;
	$("scriptUrl").value = s.scriptUrl;
	$("useGoogleLogin").checked = !!s.useGoogleLogin;
}

async function test(settings) {
	show("Testing…");
	const r = await chrome.runtime.sendMessage({ type: "testConnection", settings });
	const status = (r && (r.status || r.error)) || "no answer";
	if (status === "ok") show(`Connected. Found the tab "${settings.tabName}" with the right columns.`, "ok");
	else if (status === "tab not found") show(`The sheet has no tab called "${settings.tabName}". Check the spelling (spaces count).`, "bad");
	else show(`Problem: ${status}`, "bad");
	return status === "ok";
}

$("save").addEventListener("click", async () => {
	const s = readForm();
	const problem = validate(s);
	if (problem) return show(problem, "bad");
	$("save").disabled = true;
	try {
		await chrome.storage.sync.set(s);
		$("scriptUrl").value = s.scriptUrl;
		const ok = await test(s);
		await chrome.runtime.sendMessage({ type: "settingsSaved" });
		if (ok) show(`Saved and connected. A pinned LinkedIn messaging tab will now sync every 20 minutes.`, "ok");
	} catch (e) {
		show(`Could not save: ${e.message || e}`, "bad");
	} finally {
		$("save").disabled = false;
	}
});

$("test").addEventListener("click", async () => {
	const s = readForm();
	const problem = validate(s);
	if (problem) return show(problem, "bad");
	$("test").disabled = true;
	try {
		await test(s);
	} catch (e) {
		show(`Test failed: ${e.message || e}`, "bad");
	} finally {
		$("test").disabled = false;
	}
});

$("reset").addEventListener("click", async () => {
	if (!confirm("Reset sync history? The next sync will re-check your 50 most recent conversations.")) return;
	await chrome.runtime.sendMessage({ type: "resetHistory" });
	show("Sync history cleared.", "ok");
});

load().catch(e => show(`Could not load settings: ${e.message || e}`, "bad"));
