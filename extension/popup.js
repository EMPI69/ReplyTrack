// ReplyTrack — toolbar popup: status + "Sync now".
const $ = id => document.getElementById(id);
const STALE_SYNC_MS = 3 * 60 * 1000; // same as background.js

function ago(ts) {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}

function fmtTime(ts) {
	const d = new Date(ts);
	const sameDay = d.toDateString() === new Date().toDateString();
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return `${sameDay ? "Today" : d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time} (${ago(ts)})`;
}

async function render() {
	const settings = await chrome.storage.sync.get({ tabName: "", scriptUrl: "" });
	const { status = {}, syncStopped = false } = await chrome.storage.local.get(["status", "syncStopped"]);
	const configured = !!(settings.tabName && settings.scriptUrl);

	$("setup").classList.toggle("hidden", configured);
	$("tab").textContent = settings.tabName || "—";
	$("lastSync").textContent = status.lastSyncAt ? fmtTime(status.lastSyncAt) : "never";
	$("lastSent").textContent = status.lastSyncAt ? String(status.lastSent || 0) : "—";

	const running = !syncStopped && status.syncing && Date.now() - (status.heartbeatAt || 0) < STALE_SYNC_MS;
	const state = syncStopped ? "stopped" : running ? "syncing" : "running";
	$("state").textContent = { stopped: "Stopped", syncing: "Syncing now…", running: "Running" }[state];
	$("state").className = state;
	$("toggle").textContent = syncStopped ? "Start sync" : "Stop sync";
	$("toggle").className = syncStopped ? "start" : "stop";
	$("toggle").disabled = false;

	const box = $("status");
	box.className = "status";
	if (running) {
		box.classList.add("running");
		box.textContent = `Syncing… ${status.progress || ""}`;
	} else if (status.lastError) {
		box.classList.add("bad");
		box.textContent = status.lastError;
	} else if (status.lastSummary) {
		box.textContent = status.lastSummary;
	} else {
		box.textContent = configured ? "Waiting for the first sync." : "Not set up.";
	}
	$("syncNow").disabled = !configured || running || syncStopped;
}

$("toggle").addEventListener("click", async () => {
	const starting = $("toggle").classList.contains("start");
	$("toggle").disabled = true;
	try {
		const r = await chrome.runtime.sendMessage({ type: starting ? "startSync" : "stopSync" });
		if (!r || !r.ok) throw new Error((r && (r.reason || r.error)) || "no answer from the extension");
	} catch (e) {
		$("status").className = "status bad";
		$("status").textContent = `Could not ${starting ? "start" : "stop"} sync: ${e.message || e}`;
	}
	render().catch(e => console.warn("[ReplySync]", e));
});

$("syncNow").addEventListener("click", async () => {
	$("syncNow").disabled = true;
	$("status").className = "status running";
	$("status").textContent = "Starting a sync…";
	try {
		const r = await chrome.runtime.sendMessage({ type: "syncNow" });
		if (!r || !r.ok) {
			$("status").className = "status bad";
			$("status").textContent = (r && (r.reason || r.error)) || "Could not start a sync.";
			$("syncNow").disabled = false;
		}
	} catch (e) {
		$("status").className = "status bad";
		$("status").textContent = `Could not start a sync: ${e.message || e}`;
		$("syncNow").disabled = false;
	}
});

const openSettings = e => {
	e.preventDefault();
	chrome.runtime.openOptionsPage();
};
$("settings").addEventListener("click", openSettings);
$("setupLink").addEventListener("click", openSettings);

chrome.storage.onChanged.addListener(() => render().catch(e => console.warn("[ReplySync]", e)));
render().catch(e => console.warn("[ReplySync]", e));
