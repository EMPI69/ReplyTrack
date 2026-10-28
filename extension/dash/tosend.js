// To send: "Admin replies" and "Already connected" (send your message as a chat). One card
// per item; Send asks first, goes one at a time, and is checked in the conversation by the
// service worker (bg/admin.js) — this page only shows the state and passes your answers.
$("adRefresh").innerHTML = `${ICON.refresh}Refresh`;
const PLACEHOLDER = /\{\{?\s*[A-Za-z][\w .\-]{0,40}?\s*\}\}?/; // one the sheet couldn't fill
const STATE_TEXT = {
	queued: j => `Waiting for ${BUSY[j.waitingFor] || "LinkedIn to be free"} to finish…`,
	checking: j => j.msg || "Checking…",
	sending: () => "Sending…",
	verifying: () => "Sent — checking it arrived in the conversation…",
	already: () => "This message is already in the conversation",
	unclear: () => "Couldn't confirm — check the conversation on LinkedIn",
};
const cards = new Map(); // id → element (kept, so what you type stays)
const localNote = {}; // id → { text, kind }: answers to buttons pressed on this page

function card(it) {
	let el = cards.get(it.id);
	if (el) return el;
	const chat = it.kind === "chat";
	el = document.createElement("div");
	el.className = "card msg-card";
	el.innerHTML =
		`<div class="who"><a class="name" target="_blank" rel="noopener"></a><span class="label row"></span></div>` +
		(chat ? "" : `<div class="label">Their latest message</div><div class="quote their"></div>`) +
		`<div class="label">${chat ? "Personalized Message" : "Admin reply"} <span class="edited hidden">· edited</span></div>` +
		`<textarea rows="${chat ? 5 : 4}"></textarea><div class="note"></div><div class="actions"></div>`;
	const ta = el.querySelector("textarea");
	ta.value = it.admin;
	ta.addEventListener("input", () => {
		el.querySelector(".edited").classList.toggle("hidden", S.norm(ta.value) === S.norm(it.admin));
		renderActions(el, el._it || it);
	});
	el.querySelector(".actions").addEventListener("click", e => act(e, el));
	cards.set(it.id, el);
	return el;
}

function fillCard(el, it) {
	const job = st.adJob || null;
	const notes = st.adNote || {};
	const paused = !!st.rtPaused;
	el._it = it;
	const a = el.querySelector(".name");
	a.textContent = it.name;
	if (it.url) a.href = it.url;
	el.querySelector(".row").textContent = `Row ${it.row}`;
	const their = el.querySelector(".their");
	if (their) setHTML(their, it.latest ? `${esc(it.latest.text)}${it.latest.when ? `<span class="when">${esc(it.latest.when)}</span>` : ""}` : '<span class="muted">Nothing in Response / Notes.</span>');
	const ta = el.querySelector("textarea");
	const mine = job && job.id === it.id ? job : null;
	ta.disabled = !!mine || paused;
	const n = localNote[it.id] || notes[it.id];
	let note = "";
	if (mine) note = `<span class="${mine.state === "unclear" ? "err" : "muted"}">${esc(STATE_TEXT[mine.state] ? STATE_TEXT[mine.state](mine) : mine.msg || "")}</span>`;
	else if (it.noLink) note = '<span class="err">This row has no LinkedIn Profile link.</span>';
	else if (it.connected === "no") note = '<span class="muted">Not connected yet — LinkedIn only allows messages to connections</span>';
	else if (it.kind === "chat" && PLACEHOLDER.test(ta.value)) note = `<span class="err">Fill in ${esc(ta.value.match(PLACEHOLDER)[0])} before sending — the sheet had nothing for it.</span>`;
	if (!mine && n) note += `${note ? "<br>" : ""}<span class="${n.kind === "error" ? "err" : "muted"}">${esc(n.text)}</span>`;
	setHTML(el.querySelector(".note"), note);
	renderActions(el, it);
}

function renderActions(el, it) {
	const job = st.adJob || null;
	const mine = job && job.id === it.id ? job : null;
	const other = job && job.id !== it.id;
	const paused = !!st.rtPaused;
	const chat = it.kind === "chat";
	const text = el.querySelector("textarea").value;
	const threadUrl = mine && mine.thread ? `https://www.linkedin.com/messaging/thread/${mine.thread}/` : it.url;
	let html = "";
	if (mine && ["queued", "checking"].includes(mine.state)) html = '<button class="btn sm secondary" data-act="cancel">Cancel</button>';
	else if (mine && ["sending", "verifying"].includes(mine.state)) html = "";
	else if (mine && mine.state === "already") html = `<button class="btn sm primary" data-act="mark">${ICON.check}Mark as sent</button><button class="btn sm secondary" data-act="cancel">Close</button>`;
	else if (mine && mine.state === "unclear")
		html = `<button class="btn sm primary" data-act="was">It was sent</button><button class="btn sm secondary" data-act="wasnt">It wasn't sent</button><a class="link byhand" href="${esc(threadUrl)}" target="_blank" rel="noopener">Open the conversation</a>`;
	else {
		const blocked = paused || other || it.noLink || it.connected === "no" || !text.trim() || (chat && PLACEHOLDER.test(text));
		html =
			`<button class="btn sm primary" data-act="send" ${blocked ? "disabled" : ""}>${ICON.send}Send</button>` +
			`<button class="btn sm secondary" data-act="skip" ${mine ? "disabled" : ""}>Skip</button>` +
			(it.noLink ? "" : '<button class="link byhand" data-act="hand">Already sent by hand</button>');
	}
	setHTML(el.querySelector(".actions"), html);
}

async function act(e, el) {
	const btn = e.target.closest("[data-act]");
	if (!btn) return;
	const what = btn.dataset.act;
	const it = el._it;
	const text = el.querySelector("textarea").value;
	let res;
	delete localNote[it.id];
	if (what === "send") {
		if (!confirm(`Send this message to ${it.name}?`)) return;
		btn.disabled = true;
		res = await send({ type: "AD_SEND", id: it.id, text });
	} else if (what === "skip") res = await send({ type: "AD_SKIP", id: it.id });
	else if (what === "hand") {
		const then = it.kind === "chat" ? `Row ${it.row} gets Outreach Status “Sent” with the Sent Date left empty.` : `Admin Reply and Response / Notes are cleared in row ${it.row}.`;
		if (!confirm(`Mark this ${it.kind === "chat" ? "message" : "reply"} to ${it.name} as already sent by hand?\n\nNothing is sent. ${then}`)) return;
		res = await send({ type: "AD_BY_HAND", id: it.id, text });
	} else if (what === "mark") res = await send({ type: "AD_BY_HAND", id: it.id, text });
	else if (what === "cancel") res = await send({ type: "AD_CANCEL", id: it.id });
	else if (what === "was") {
		const then = it.kind === "chat" ? `Row ${it.row} then gets Outreach Status “Sent” and today's Sent Date.` : `Admin Reply and Response / Notes are then cleared in row ${it.row}.`;
		if (!confirm(`You checked the conversation and the message is there?\n\n${then}`)) return;
		res = await send({ type: "AD_UNCLEAR", id: it.id, sent: true });
	} else if (what === "wasnt") {
		if (!confirm("You checked the conversation and the message is NOT there?\n\nThen it can be sent again.")) return;
		res = await send({ type: "AD_UNCLEAR", id: it.id, sent: false });
	}
	if (res && !res.ok) localNote[it.id] = { text: res.error || "Didn't work.", kind: "error" };
	el.querySelector(".actions")._html = null; // redraw the buttons (one was disabled by hand above)
	render();
}

function place(items, box) {
	items.forEach((it, i) => {
		const el = card(it);
		if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
		fillCard(el, it);
	});
}

onRender(() => {
	if (tab !== "tosend") return;
	const list = st.adList || [];
	const paused = !!st.rtPaused;
	const rows = st.adRows;
	$("adRead").textContent = rows ? `Sheet read ${ago(rows.at)}` : "";
	$("adRefresh").disabled = !configured();
	$("adPaused").classList.toggle("hidden", !paused);

	const ids = new Set(list.map(x => x.id));
	for (const [id, el] of cards)
		if (!ids.has(id)) {
			el.remove();
			cards.delete(id);
		}
	const admins = list.filter(x => x.kind !== "chat");
	const chats = list.filter(x => x.kind === "chat");
	place(admins, $("list"));
	place(chats, $("chatList"));
	$("adCount").textContent = admins.length ? `${admins.length} waiting` : "";
	$("adEmpty").classList.toggle("hidden", admins.length > 0);
	$("chatEmpty").classList.toggle("hidden", chats.length > 0);
	setHTML(
		$("adEmpty"),
		configured() ? empty("inbox", "No admin replies", "Replies your manager writes in the main sheet show up here, ready to send.") : empty("inbox", "Not set up yet", "Connect your sheet in Settings.")
	);
	setHTML($("chatEmpty"), empty("users", "Nobody here", "People an outreach run finds already connected show up here, to send their message as a chat."));

	if ($("adDetails").closest("details").open) {
		const job = st.adJob;
		$("adDetails").textContent =
			`${list.length} waiting · ${rows ? `${rows.rows.length} rows with an Admin Reply, ${(rows.chats || []).length} already-connected rows (read ${ago(rows.at)})` : "sheet not read yet"}\n` +
			(job ? `In progress: ${job.name} — ${job.state}${job.thread ? ` (conversation ${job.thread})` : ""}\n` : "") +
			"\n" +
			(st.rsLog || [])
				.slice(-30)
				.map(e => `${fmtTime(e.t)} ${e.msg}`)
				.join("\n");
	}
});

$("adRefresh").addEventListener("click", async () => {
	$("adRefresh").disabled = true;
	$("adRead").textContent = "Reading your sheet…";
	const res = await send({ type: "AD_REFRESH", force: true });
	$("adRefresh").disabled = false;
	if (!res || !res.ok) alert(`Couldn't read your sheet: ${(res && res.error) || "no answer"}`);
	render();
});
