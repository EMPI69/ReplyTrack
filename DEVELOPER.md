# ReplyTrack — developer notes

The technical side of ReplyTrack: how it's built, what it stores, the rules the sheet script enforces, how to test it, and what to do when LinkedIn changes its pages. Team members only need [README.md](README.md).

## Contents

- [Files](#files)
- [How it fits together](#how-it-fits-together)
- [The sheet and Code.gs](#the-sheet-and-codegs)
- [Outreach](#outreach)
- [Who accepted](#who-accepted)
- [Reply capture](#reply-capture)
- [Admin Replies and “Already connected” chats](#admin-replies-and-already-connected-chats)
- [The dashboard](#the-dashboard)
- [Messages, alarms and storage](#messages-alarms-and-storage)
- [When LinkedIn changes its pages](#when-linkedin-changes-its-pages)
- [Logs and debugging](#logs-and-debugging)
- [Testing checklist](#testing-checklist)
- [Before you commit](#before-you-commit)
- [Good to know](#good-to-know)

---

## Files

```
replytrack/
├── README.md              ← for team members (set-up and daily use)
├── DEVELOPER.md           ← this file
├── docs/images/           ← README screenshots (made with sample data only)
├── apps-script/
│   └── Code.gs            ← goes into each member's OWN Google Sheet, deployed as their own web app
└── extension/             ← the Chrome extension (Manifest V3; load this folder)
    ├── manifest.json
    ├── background.js      ← the one service worker: importScripts() the parts in bg/, one message router
    ├── bg/
    │   ├── common.js      ← helpers, the [Outreach] / [ReplySync] logs, recent activity
    │   ├── sheet.js       ← the member's sheet: Apps Script calls with the secret key, write outbox
    │   ├── lock.js        ← one thing at a time on LinkedIn
    │   ├── linkedin.js    ← the minimized worker window/tab where outreach.js runs
    │   ├── outreach.js    ← connection requests from the sheet's rows
    │   ├── replysync.js   ← the pinned messaging tab, replies → Response / Notes
    │   ├── accepted.js    ← twice a day: who accepted
    │   ├── admin.js       ← the “To send” list, sending one message, verifying it
    │   └── control.js     ← Pause everything / Start again
    ├── outreach.js        ← injected ONLY into the worker tab: Voyager API calls (profile, invite, message, connections)
    ├── content.js         ← content script on linkedin.com/messaging/*: reads conversations (CONFIG selectors at the top)
    ├── shared.js          ← sheet column names, placeholders and the note, defaults, CSV helpers
    ├── dashboard.html / dashboard.css   ← the dashboard (the toolbar icon opens it as a tab)
    ├── dash/              ← the dashboard's scripts: theme, core, overview, outreach, replies, tosend, settings
    ├── fonts/             ← Montserrat + JetBrains Mono (woff2) and their SIL Open Font License files
    └── icons/             ← 16 / 32 / 48 / 128 px
```

---

## How it fits together

- **One service worker** (`background.js`) loads `shared.js` and `bg/*.js` with `importScripts()`. Each `bg/` file is one module (`const Sheet = (() => { … })()` and so on), so names don't collide in the shared global scope. One `chrome.runtime.onMessage` listener routes every message; types it doesn't know get no answer (they're meant for a tab).
- **The member's sheet** is reached only through their Apps Script web app (`bg/sheet.js`). Reads are immediate. Writes go through an **outbox** in `storage.local` and are retried every minute, in order, until they go through. Only sheet writes are ever retried — never anything on LinkedIn.
- **The lock** (`bg/lock.js`, kept in `storage.session`) makes sure only one of these touches LinkedIn at a time: `outreach` (a run or dry run, for the whole run), `replysync`, `accepted`, `admin` (sending one message) and `adminCheck` (connection look-ups for the To send list). An Admin Reply waiting goes first; otherwise first come, first served. A holder that stops beating for 3 minutes loses it. When the lock is released, a reply sync or accepted check that had to wait runs.
- **The worker tab** (`bg/linkedin.js`): one minimized window with an about:blank tab and a LinkedIn tab. `outreach.js` is injected there (isolated world) and calls LinkedIn's Voyager API with same-origin `fetch()` — the user's cookies and CSRF token. LinkedIn's own `x-li-*` headers are read from the tab's requests with `chrome.webRequest`. Calls are never retried for `OR_INVITE` and `OR_MESSAGE` (they may have gone through).
- **The pinned messaging tab** (`bg/replysync.js` + `content.js`): reloaded every 20 minutes (and 30 s after the computer wakes up); each load makes `content.js` ask `shouldSync`, take the lock, and walk the newest conversations.
- **The dashboard** (`dashboard.html` + `dash/*.js`) reads `chrome.storage` and sends messages to the service worker; it never talks to LinkedIn or the sheet itself.

---

## The sheet and Code.gs

Each team member has their **own Google Sheet file**, synced with the main sheet the managers read. ReplyTrack only reads and writes **that** sheet, and only the tab named in its settings (e.g. `MY LEADS`). Columns are found **by their header in row 1** (case and extra spaces ignored), never by position.

| Column | What ReplyTrack does |
|---|---|
| LinkedIn Profile | reads (`https://www.linkedin.com/in/...`; the URL behind link text or inside `=HYPERLINK()` also works) |
| Personalized Message | reads — the connection note / chat message |
| Outreach Status | writes **Sent** (only from empty or *Not Started*) and **Replied** (only from *Sent*) |
| Sent Date | writes the date a request was sent (a real date, `dd mmm yyyy`); left empty when that date isn't known; a hand-typed Sent Date is kept |
| Response / Notes | writes their replies, and “Accepted but not replied” |
| Admin Reply | reads; **cleared** (with Response / Notes) only after an Admin Reply was seen in the LinkedIn conversation |
| Team Member | read only — the dashboard's “Welcome back, …” |
| every other column | read only (for `{placeholders}`) — never written: Batch ID, Campaign, Name, Company Name, Source Tab, Source Row, Allotted On, Allotment #, … |

### Code.gs actions

Every request is a POST with a JSON body `{ "key": "<SECRET_KEY>", "tab": "MY LEADS", "action": "…", … }`. A request without the right key is rejected before anything is read. While `SECRET_KEY` is still `CHANGE-ME` (or shorter than 16 characters) every request is rejected. `doGet` returns only “ok — ReplyTrack web app is running”.

| Action | Does |
|---|---|
| `ping` | checks the tab, the six columns, the Outreach Status dropdown, formula-filled columns and protections |
| `read` | every row, all columns as displayed (the profile column holds the link itself), Sent Dates as ms, the dropdown values |
| `markSent { profileUrl, sentAt }` | “Sent” + Sent Date (the day of `sentAt`; no `sentAt` → Sent Date left empty) in every row of that person whose status is empty / Not Started |
| `markAccepted { profileUrl }` | “Accepted but not replied” where status is Sent and Response / Notes is empty |
| `addReplies { profileUrl, replies, sentAt }` | their messages into Response / Notes; Sent → Replied |
| `clearAdmin { profileUrl, row, adminText, notesText }` | after a verified Admin Reply: clears Admin Reply and Response / Notes in that row (contents only) |

Answers are JSON: `{ ok: true, … }` or `{ ok: false, error }` with errors such as `wrong key`, `set SECRET_KEY in Code.gs`, `tab not found`, `missing column: <name>`, `profile not in tab`, `cell full`, `admin reply changed — not cleared`, `bad request`, `busy, try again`, `error: …`. Writes take `LockService.getScriptLock()`.

### Rules Code.gs enforces, whatever the extension asks

- Only Outreach Status, Sent Date, Response / Notes and Admin Reply are ever written; Admin Reply is only ever cleared.
- Outreach Status only ever gets “Sent” or “Replied”, and only if that value is in the cell's dropdown (its own rule, else the column's). Never “Bounced”, never anything else.
- A cell with a **formula** is never written — it's skipped and logged. A column filled by one formula at the top (ARRAYFORMULA, IMPORTRANGE, QUERY, FILTER, …) is never written at all.
- Text in Response / Notes is never deleted or overwritten — new replies are added below it, keeping the existing text and its formatting. Exceptions: the exact text “Accepted but not replied” (replaced by the first reply), and the clear after a verified Admin Reply (replies that arrived after the extension read the cell are kept).
- Clearing removes contents only — formatting and dropdowns stay. Columns are never added, removed or moved.
- Rows are matched by the LinkedIn Profile link (case, `www`, trailing `/`, `?…` and URL encoding don't matter). The same person in two rows → both rows are updated.
- Dates and reply times use the spreadsheet's time zone (**File → Settings**), `Asia/Kolkata` if none is set. Reply format: `[27 Oct 2026, 11:42 PM] text`, oldest first, a blank line between messages, never twice.
- `testSetup()` (run from the editor) logs the key status, the time zone and, per tab, the columns, the dropdown and any problems. Read-only.

**Changing Code.gs later:** **Deploy → Manage deployments → ✏️ → Version: New version → Deploy** keeps the same URL. (“New deployment” makes a new URL.) Editing the code without deploying a new version doesn't change what the web app runs.

---

## Outreach

- Rows are read from the sheet at every **Start** and with **Reload rows from sheet**.
- A request is only sent to rows whose **Outreach Status is empty or “Not Started”** and that have **both** a LinkedIn Profile and a Personalized Message. Any other status (Sent, Drafted, Replied, Meeting Booked, Follow-up, Not Interested, Bounced) is never touched — and if another row for the same person has such a status, that person isn't touched either.
- After a request is sent: **Sent** + today's **Sent Date**. No request is sent, but the row still gets **Sent**, when:
  - this extension already sent that person a request (its history `h:<key>`, imported history included) → Sent Date = the date it was sent then (left empty if the history has no date);
  - LinkedIn shows a request already pending → Sent Date left empty.
- Already a 1st-degree connection → no request possible; the person is recorded in `adConnected` and listed in **To send → Already connected** (see below).
- Other skipped rows and failed rows keep their status; the reason shows in the extension only. A row skipped because of its note waits again as soon as the row (or the typed note) changes.
- Pace (defaults, Settings → Outreach): wait 4–10 s on each profile, 5–10 s before the next, 3–6 s after a skipped row, a 1–3 minute break about every 25 requests, auto-stop at 500 a day (Continue sends another day's worth). The first 3 requests of a run and ~1 in 20 after are checked on LinkedIn (the profile must show the request as pending, else the run stops). Unclear answers are counted and re-checked on Continue. Automatic stops: signed out, “too many requests” (429/999), LinkedIn's invitation limit, note refused, 5 errors in a row.
- **Dry run** looks every waiting row up and says what would happen — sends nothing, writes nothing.
- Everyone this extension sent a request to is remembered **forever** (`h:<key>`); **Import sent history** adds the old extension's history (a missing date = “sent, date unknown”).
- Placeholders: `{Name}`, `{Company Name}` — any column — plus `{firstName}`, `{lastName}`, `{fullName}`, `{headline}` from the profile. Keys match ignoring case, spaces and punctuation. A placeholder with nothing to fill it, or a note over 300 characters, skips the row.
- **Self-repair:** when the user sends a connection request **with a note** by hand in any LinkedIn tab, the page's own request is learned (via `chrome.webRequest`) and tried first (`orTplInvite`); after 3 failures the built-in one is used again.

## Who accepted

Twice a day — around 10 AM and 4 PM local time, or the next time Chrome is open after that (checked by the 15-minute `rt-tick` alarm) — rows with Outreach Status **Sent**, an empty Response / Notes and a Sent Date in the last **30 days** are compared with the user's **recently added connections** (a few paged requests, sorted by RECENTLY_ADDED, not one per row). Matches get “Accepted but not replied”. Rows without a Sent Date aren't checked. **Check now** in the Outreach tab runs it at once. Waits for the lock; off while paused.

## Reply capture

- Every 20 minutes (`replysync-reload`), 30 s after the computer is active again (`replysync-wake`), and 1 minute after a failure for lack of internet (`replysync-retry`), the pinned messaging tab is reloaded and `content.js` goes through the newest conversations at a human pace (2–5 s between conversations). The first sync checks the 50 most recent conversations; later ones go back to the last sync (10-minute overlap), at most 200.
- Only **the other person's** messages are taken (`--other` class, sender link or name). `/in/ACoAA…` links are turned into vanity links (profile API → page HTML → a background tab; cached in `vanityCache`).
- Group conversations and sponsored / InMail threads are skipped. A conversation is only written if that person is in the tab (`profile not in tab` otherwise).
- Never twice: `sentHashes` per conversation and text; Code.gs also checks the entries already in the cell.
- Admin Replies: a message whose text is one of the Admin Replies or chats sent to that person (`adHistory`) is never taken as their reply. After an Admin Reply (which clears Response / Notes), only their messages **after** that reply count — by position in the conversation, else by LinkedIn's time. Chats don't start a new “since” (they don't clear the cell).
- Status Sent → Replied (no other status changes). The dashboard's “Replies today” (`rsToday`) and “Latest replies” (`rsRecent`) are updated.

## Admin Replies and “Already connected” chats

**Admin replies:** rows whose Admin Reply has text not sent (or skipped) before. **Already connected:** rows still empty / Not Started whose person an outreach run found already connected; the message is the row's Personalized Message with placeholders filled (Send stays disabled while one is unfilled).

**Send** (after the user confirms “Send this message to <Name>?”; one at a time, never automatic):

1. Wait for the lock (Cancel works until the message goes out).
2. Look the row's own LinkedIn Profile up — it must be 1st-degree (else “Not connected yet — LinkedIn only allows messages to connections”).
3. Open the conversation (known from the reply sync, `rsThreads`, else LinkedIn's participants lookup) in the worker tab: if the user already sent this exact text there → “This message is already in the conversation” → **Mark as sent**.
4. A human pause (`readMin`–`readMax`), then the text goes into `adHistory` as “unconfirmed” (write-ahead) and **one** message is sent (`OR_MESSAGE`). Another request shape is tried only when LinkedIn clearly rejected the previous one's format (HTTP 400/404/405/410/415/422 — nothing was sent then). Never retried otherwise.
5. Read the conversation back (`RT_READ_THREAD`, the same selectors as reply capture). Only a message seen there counts → history “sent”, then:
   - Admin Reply: `clearAdmin` (Admin Reply + Response / Notes cleared);
   - chat: `markSent` with today's date (Sent Date left empty for “Mark as sent” / “Already sent by hand”); nothing cleared.
   Not seen / unclear answer → “Couldn't confirm — check the conversation on LinkedIn” → **It was sent** / **It wasn't sent**. If the extension restarts mid-send the job becomes “Couldn't confirm”.

- **Never the same text twice** to the same person: `adHistory` is per person and never expires; a text in it can't be sent again and doesn't show in the list again (e.g. if the sheet sync copies a cleared Admin Reply back). An edited text also retires the original.
- **Skip** hides an item until its text changes (`adSkipped`). **Already sent by hand** records it without sending (Admin Reply: cells cleared; chat: Sent with no Sent Date).
- Connection status for the list is looked up in the background (`adminCheck`, a few at a time, at the normal pace).
- **Self-repair:** a message sent by hand in any LinkedIn tab teaches the current message request (`orTplMessage`, the text replaced by a placeholder; templates that still name a conversation or person are discarded).

---

## The dashboard

- The toolbar icon opens `dashboard.html` as a tab, or switches to it if it's open (`chrome.runtime.getContexts`). `#overview`, `#outreach`, `#replies`, `#tosend`, `#settings` select the tab (the sections' ids are `page-…` so the hash doesn't scroll the page). `options_ui` also points at it.
- `dash/core.js` holds the shared state (`chrome.storage` snapshot), top bar, banner, tabs and theme; each section registers `onRender()` (every storage change and once a second) and `onChange()` (heavy work only when its data changes).
- **Status pill:** green **Active** (automatic reply syncing on, outreach not stopped part-way), amber **Partly paused** (reply sync stopped, or an outreach run stopped with rows still waiting), grey **Paused** (only after Pause everything), grey **Not set up** (no settings yet).
- **Banner** (only when action is needed): Not set up yet · LinkedIn logged out — sign in again · Daily invite limit reached — press Continue tomorrow · Can't reach your sheet — check settings.
- **Badge:** the number of To send items (`Admin.rebuild()`).
- Settings: the Connection fields save with **Save** (which also tests); unsaved changes show a bottom bar with Save / Discard. Outreach settings save as you type.
- Theme: dark by default; the choice is kept in the page's `localStorage` (`rtTheme`). Fonts are bundled (SIL OFL 1.1, licence files in `fonts/`); nothing is loaded from the internet.

---

## Messages, alarms and storage

**Messages to the service worker:** `OR_START`, `OR_STOP`, `OR_LOAD`, `OR_COUNTS`, `OR_IMPORT`, `AC_CHECK`, `AD_REFRESH`, `AD_SEND`, `AD_CANCEL`, `AD_SKIP`, `AD_BY_HAND`, `AD_UNCLEAR`, `RT_PAUSE`, `RT_RESUME`, and from the reply sync / settings: `sleep`, `shouldSync`, `syncStarted`, `syncProgress`, `syncFinished`, `resolveProfile`, `cacheVanity`, `postConversation`, `loggedOut`, `syncNow`, `testConnection`, `resetHistory`, `settingsSaved`, `stopSync`, `startSync`.

**Messages to tabs:** worker tab (`outreach.js`): `OR_PING`, `OR_ME`, `OR_PROFILE`, `OR_INVITE`, `OR_VERIFY`, `OR_CONNECTIONS`, `OR_FIND_THREAD`, `OR_MESSAGE`. Messaging pages (`content.js`): `RT_PING`, `RT_READ_THREAD`, `stopSync`.

**Alarms:** `replysync-reload` (20 min), `replysync-wake`, `replysync-retry`, `rt-tick` (15 min: accepted check due? outbox), `rt-outbox` (1 min while sheet writes wait).

**storage.sync:** `tabName`, `scriptUrl`, `secretKey`, `useGoogleLogin`.

**storage.local:**

| Area | Keys |
|---|---|
| Outreach | `orSheet`, `orItems`, `orSettings`, `orRun`, `orCounts`, `h:<person>` (sent history, forever), `orHeaders`, `orTplInvite`, `orMe`, `orLog` |
| Reply sync | `rsStatus`, `lastSync`, `sentHashes`, `vanityCache`, `syncTabId`, `loggedOutNotifiedAt`, `syncStopped`, `rsPending`, `rsToday`, `rsThreads`, `rsRecent`, `rsLog` |
| Accepted | `acStatus`, `acWeek` |
| To send | `adRows`, `adList`, `adConnected`, `adHistory` (forever), `adSkipped`, `adJob`, `adNote`, `adDegree`, `orTplMessage` |
| Sheet | `rtOutbox`, `rtSheetError` |
| Everything | `rtPaused`, `rtLoggedOut`, `rtActivity`, `rtMember` |

**storage.session:** `rtLock`, `orWorkerWindowId`, `orWorkerTabId`, `orSession`.

Everything is stored in this Chrome profile only. An unpacked extension's id comes from its folder path — moving the folder (or removing the extension) loses all of it.

---

## When LinkedIn changes its pages

All messaging-page selectors are in the **`CONFIG`** block at the top of `extension/content.js`. Each entry is a list of CSS selectors tried in order.

1. Open `linkedin.com/messaging` in a normal tab.
2. Right-click the part that's no longer found → **Inspect**.
3. Find something stable: a readable `msg-…` class, an `aria-label`, a `data-…` attribute, or a link pattern (`href*="/in/"`). Avoid generated classes like `ember123`.
4. Test it in the Console: `document.querySelectorAll('YOUR SELECTOR').length`.
5. Add it to the **front** of the right list and keep the old ones after it.
6. Save, click ↻ on ReplyTrack in `chrome://extensions`, then **Sync now**. **Settings → Data → Reset sync history** re-checks the last 50 conversations (nothing is duplicated).

| CONFIG entry | Finds |
|---|---|
| `conversationList`, `conversationItem` | the list of conversations and each one |
| `clickTarget` | what gets clicked to open a conversation |
| `itemName`, `itemTime` | name and last-activity time on each conversation |
| `threadTitleBar`, `threadProfileLink`, `threadName` | the bar above an open conversation, with the profile link |
| `messageList`, `messageEvent`, `messageItem`, `messageBody` | the messages and their text |
| `otherPersonMessage`, `senderLink`, `senderName` | their messages vs yours |
| `dateHeading`, `messageTime` | when each message was sent (else the capture time is used and the console says so) |
| `itemSponsoredLabel`, `itemGroupMarker` | what gets skipped |

The Voyager endpoints (profile, invitation, messaging, connections) are in `extension/outreach.js`; both the invite and the message request repair themselves from a manual send (see above).

## Logs and debugging

- Dashboard: **Outreach → Log**, **Replies → Details**, **To send → Details** (the last log lines and the technical numbers).
- Service worker: `chrome://extensions` → ReplyTrack → **service worker** → Console; filter `[Outreach]` or `[ReplySync]`.
- Each conversation of a sync is logged in the pinned tab's own console (F12).
- The sheet script logs to **Apps Script → Executions**.

---

## Testing checklist

Use a **copy of your sheet** first (File → Make a copy → put Code.gs in the copy) and a colleague's LinkedIn account as the “other person”. Then switch the settings to your real sheet.

**Set-up**
- [ ] Settings → **Test connection**: “Connected”, your tab, the dropdown values, no ⚠ lines.
- [ ] Change one character of the secret key → Test connection says the key doesn't match. Put it back.
- [ ] Click the ReplyTrack icon → the dashboard opens in a tab; click it again → Chrome switches to that tab (no second one). Green **Active**, no banner; Overview shows your name if the Team Member column has it.
- [ ] ☀ → light theme; reload the page → it stays light.
- [ ] Edit a Connection field → the “unsaved changes” bar appears; **Discard** → the saved values are back.

**Outreach**
- [ ] Add a row: colleague's profile (not yet connected), a Personalized Message with `{Name}`, Outreach Status empty. Add a second row with status **Bounced** and a third with **Sent**.
- [ ] Outreach tab → **Reload rows from sheet**: 1 person waiting; the preview shows the note with the name filled in.
- [ ] **Dry run**: the row says “would send the request…”. Nothing changes in the sheet.
- [ ] **Start** → confirm. Within a minute: the request is on LinkedIn, the row says **Sent** and today's **Sent Date**. The Bounced and Sent rows didn't change.
- [ ] Start again → “No rows are waiting”. Set the row back to *Not Started* and clear its Sent Date → Start → no request is sent, and the row gets **Sent** again with the **original** Sent Date.
- [ ] A row for someone you sent a request to by hand (still pending) → Start → no request, the row gets **Sent** and the Sent Date stays **empty**.
- [ ] Export CSV downloads your rows with the result columns.

**Who accepted**
- [ ] Colleague accepts. Outreach tab → **Who accepted → Check now** → the row's Response / Notes says **Accepted but not replied** (only if it was empty).

**Reply capture**
- [ ] Colleague sends “Test reply 1”. Replies → **Sync now**. It shows under *Latest replies* and in Overview's recent activity. Response / Notes: `[28 Oct 2026, 3:12 PM] Test reply 1` (the “Accepted…” text replaced); Outreach Status **Replied**.
- [ ] Type a note by hand under it in the cell, colleague sends “Test reply 2”, Sync now → your note is still there, the new reply is below it.
- [ ] Sync now again without new messages → nothing changes. Colleague re-sends “Test reply 1” → not added twice.
- [ ] While an outreach run is going, press Sync now → “Waiting for outreach to finish” → it syncs right after the run.

**Admin Replies**
- [ ] Write “Admin test 1” in that row's Admin Reply. Dashboard → **To send** (the icon's badge shows 1): name, their latest message, the text.
- [ ] **Send** → confirm. The colleague receives it **once**; Admin Reply and Response / Notes are cleared in that row.
- [ ] Put “Admin test 1” back into Admin Reply → it doesn't show up again.
- [ ] Write “Admin test 2”, edit the text in the box, Send → the edited text arrives.
- [ ] Send “Admin test 3” **by hand** on LinkedIn, then write the same text into Admin Reply → Send → “This message is already in the conversation” → **Mark as sent** → nothing sent, cells cleared.
- [ ] Admin Reply for someone you're not connected with → Send is greyed out: “Not connected yet — LinkedIn only allows messages to connections”.
- [ ] **Skip** an item → gone; change its text → it's back.
- [ ] Colleague replies after your Admin Reply → only that new reply appears in the now-empty Response / Notes.

**Already connected → chat**
- [ ] A row for someone you're already connected with, status empty, a Personalized Message with `{Name}` → Start → no request; the rows table says “already a connection — listed in To send”.
- [ ] To send → *Already connected*: their name, the message with the name filled in.
- [ ] **Send** → confirm → they receive it once; the row gets **Sent** and today's Sent Date; Response / Notes and Admin Reply untouched.
- [ ] Set the row back to *Not Started* → it doesn't show up again with the same message.
- [ ] Another already-connected row → **Already sent by hand** → nothing sent, the item goes away, the row gets **Sent** with an empty Sent Date.

**Everything**
- [ ] **Pause everything** → grey **Paused**; Start / Send are disabled. **Start again** → green **Active**.
- [ ] Replies → **Stop sync** → amber **Partly paused**; **Start sync** → green. Stop an outreach run part-way → amber; Continue → green.
- [ ] Sign out of LinkedIn → banner “LinkedIn logged out — sign in again” (and a notification). Sign in → the banner goes.
- [ ] Turn off Wi-Fi during a run → the request is kept, “Can't reach your sheet” banner; Wi-Fi on → the row gets Sent within a minute.

---

## Before you commit

- `apps-script/Code.gs` must keep `var SECRET_KEY = 'CHANGE-ME';` — never commit a real key. Members paste their key only in their own Apps Script editor.
- Never commit a web app URL, a Sheet link, LinkedIn cookies, `ACoAA…` ids, or real people's names / messages. The README screenshots in `docs/images/` use made-up sample data only.
- `.gitignore` excludes CSV exports, `outreach-sent-history*.json` (the old extension's history — real profiles), `*.local.gs`, `.env*`, editor folders and OS junk.

## Good to know

- **Conversations get marked as read** — the sync opens them like a person would.
- **Profile views:** looking a profile up (outreach, Admin Replies, turning `/in/ACoAA…` links into real ones) may count as a profile view.
- **The worker window** is minimized and closes when its job is done; only one job (or a reply sync) uses LinkedIn at a time.
- **LinkedIn's rules:** LinkedIn's User Agreement restricts automated tools. ReplyTrack works slowly, from the user's own signed-in browser, and never sends a message without the user pressing Send. Using it is the team's decision and risk.
