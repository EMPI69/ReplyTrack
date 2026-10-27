# ReplyTrack

When someone replies to you on LinkedIn, their reply is copied into the **Reply** column of their row in **your tab** of the team Google Sheet. It runs by itself in Chrome. Nobody has to click anything.

```
reply-sync/
├── README.md              ← this file
├── apps-script/
│   └── Code.gs            ← goes into the Google Sheet (team lead does this once)
└── extension/             ← the Chrome extension (every team member loads this)
    ├── manifest.json
    ├── background.js      ← keeps the LinkedIn tab running, talks to the Sheet
    ├── content.js         ← reads your LinkedIn messages (CONFIG at the top)
    ├── popup.html / popup.js
    ├── options.html / options.js
    └── icons/ icon16.png  icon48.png  icon128.png
```

**How it works:** the extension keeps one **pinned** LinkedIn Messaging tab open and reloads it every 20 minutes. It also reloads it 30 seconds after the computer wakes up or you come back to it. Each time the tab loads, the extension goes through your newest conversations at a human pace (2–5 seconds between each). It picks out the messages the *other person* sent, and when they sent them, and sends those to the Google Sheet. The Sheet finds that person's row by their LinkedIn profile link and fills in the Reply column like this:

```
[27 Oct 2026, 11:42 PM] Thanks for reaching out!

[28 Oct 2026, 9:15 AM] Tuesday works for a call.
```

Each message gets the time the person sent it on LinkedIn, shown in the spreadsheet's time zone. Messages are listed oldest first, with a blank line between them, and the same message is never added twice. If the internet is down, the extension tries again every minute until it's back.

**The sheet stays clean:** the only thing ever written is reply text in the Reply column. Errors and statuses only appear in the extension's popup. If anything goes wrong, the sheet isn't touched.

---

## Part 1: Set up the Google Sheet (team lead, once)

1. Open the team Google Sheet. Check that **row 1** of every person's tab has the same headers, for example `Profile URL`, `Note`, `Reply`.
   Also check **File → Settings → Time zone**. Reply times are written in this time zone, so set it to your team's time zone.
2. Click **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete everything in the editor. Open `apps-script/Code.gs` from this folder, copy all of it, and paste it in.
4. Near the top, change the two header names to match your sheet **exactly** (upper/lower case doesn't matter):
   ```js
   var PROFILE_HEADER = 'Profile URL';
   var REPLY_HEADER = 'Reply';
   ```
5. Click the 💾 **Save** icon.
6. **Check your tabs:** in the toolbar dropdown next to "Debug", choose **testSetup** and click **▶ Run**.
   - Google will ask for permission. Click **Review permissions**, choose your account, then **Advanced → Go to (project name) (unsafe)** → **Allow**. ("Unsafe" just means you wrote the script yourself rather than downloading it from Google.)
   - The **Execution log** at the bottom should list every tab with `found` for both columns. If it says `MISSING`, fix the header in the sheet or the name in step 4.
7. **Publish it as a web app:** click **Deploy → New deployment**.
   - Click the ⚙️ gear next to "Select type" → **Web app**.
   - Description: `ReplyTrack`
   - **Execute as: Me**
   - **Who has access: Anyone**
   - Click **Deploy** (approve permissions again if asked).
8. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`. Send this URL to every team member.
9. (Optional check) Paste the URL into a browser. It should say `ok — ReplyTrack web app is running`.

> **Changing the script later:** use **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**. This keeps the same URL. Don't use "New deployment" for updates, because that creates a new URL and everyone would have to change their settings.
>
> **"Anyone" isn't in the list?** Some company Google accounts block it. Pick **"Anyone within (your company)"** instead. Each team member then ticks **"Send my Google login with each request"** in the extension settings and must be signed in to Chrome with their company Google account.

---

## Part 2: Install the extension (each team member, once)

1. Get the `reply-sync` folder (your team lead can zip and share it). Put it somewhere it will **stay**, e.g. `Documents\reply-sync`. Chrome loads the extension from this folder every time, so don't delete or move it.
2. Open Chrome and type `chrome://extensions` in the address bar.
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and select the **`extension`** folder inside `reply-sync` (the folder that contains `manifest.json`).
5. Click the 🧩 puzzle icon in Chrome's toolbar and **pin** "ReplyTrack" so its blue **R** icon is always visible.
6. A **Settings** page opens automatically. (To open it later, click the R icon → **Settings**.)
   - **Your tab name:** your tab's name in the Google Sheet, spelled exactly the same, e.g. `John`.
   - **Apps Script web app URL:** the URL from your team lead.
   - Click **Save**. You should see **"Saved and connected."** If you see an error, read it: it tells you what's wrong (for example, the tab name is misspelled).
7. Make sure you're **signed in to LinkedIn** in this Chrome.
8. A small **pinned LinkedIn tab** appears at the far left of your tabs. **Leave it open.** That tab does the work. If you close it, it comes back within 20 minutes.

> Chrome may show a "Disable developer mode extensions" message when it starts. Click ✕ to close it. Don't click "Disable".

---

## Updating from version 1.0

Only needed if you installed the first version, where replies were separated by `---` and had no times. Doing the steps in either order is safe, but the Sheet step is best done first.

**Team lead: update the Sheet script**
1. Open the Sheet → **Extensions → Apps Script**.
2. Replace all the code with the new `apps-script/Code.gs`. Set `PROFILE_HEADER` and `REPLY_HEADER` again if you changed them before.
3. Click 💾 **Save**.
4. Click **Deploy → Manage deployments → ✏️ (edit)**. Under **Version**, choose **New version**, then click **Deploy**. The URL stays the same, so team members don't need to change anything.
5. Check **File → Settings → Time zone** (see Part 1, step 1).

**Each team member: update the extension**
1. Replace the files in your `reply-sync` folder with the new ones (same place on your computer).
2. Go to `chrome://extensions` and click the **↻ reload** icon on ReplyTrack. Your settings are kept.

**Existing Reply cells:** text already in a cell is kept. The next time that person sends a new message, the cell is tidied up. The old messages, which have no time, stay at the top. The `---` lines are removed, and the new messages are added below with their times.

---

## Part 3: Make Chrome open by itself when the computer starts

**Windows**
1. Press **Windows key + R**, type `shell:startup`, press Enter. A folder opens.
2. Right-click Chrome on your desktop or in the Start menu → **Open file location** (if needed) → right-click **Google Chrome** → **Copy**.
3. In the startup folder, right-click → **Paste shortcut**.
4. In Chrome: **⋮ menu → Settings → System** → turn on **"Continue running background apps when Google Chrome is closed."**
5. (Recommended) **Settings → On startup → "Continue where you left off"** so the pinned tab is restored.

**Mac**
1. Open **System Settings → General → Login Items**.
2. Under **Open at Login**, click **+**, choose **Google Chrome** from Applications, and click **Open**.
   (Or: right-click Chrome in the Dock → **Options → Open at Login**.)
3. (Recommended) In Chrome: **Settings → On startup → "Continue where you left off."**

> If you use several Chrome profiles, the extension must be installed in the profile where you're signed in to LinkedIn, and that profile must be the one that opens at startup.

---

## Part 4: Keep the computer awake during work hours

The computer must be **on and logged in**, with Chrome running. The **screen can turn off** and the computer **can be locked**. Both are fine. Only **sleep** stops syncing. When the computer wakes up again, the extension syncs within about 30 seconds, so nothing that arrived during sleep is missed.

**Windows 11**
1. **Settings → System → Power & battery → Screen, sleep, & hibernate timeouts.**
2. Set **"When plugged in, put my device to sleep after"** to **Never**. The screen timeout can stay as it is.
3. Laptops: keep it plugged in. Under **Lid & power button controls**, set **"When I close the lid" (plugged in)** to **Do nothing** if you close the lid.
   *(For work hours only: Microsoft's free **PowerToys → Awake** can keep the PC awake until a set time.)*

**Mac**
1. **System Settings → Battery → Options** (on a desktop Mac: **System Settings → Energy**).
2. Turn on **"Prevent automatic sleeping on power adapter when the display is off."**
3. Laptops: keep it plugged in and the lid open (a closed lid sleeps unless an external monitor is attached).
   *(Optional, to wake it every weekday morning: open **Terminal** and run `sudo pmset repeat wakeorpoweron MTWRF 08:45:00`.)*

---

## Part 5: Testing checklist

Do this once after setup, using a second LinkedIn account (a colleague's or a test account).

- [ ] In your tab, add a row with the **second account's** profile link in the Profile URL column (copy it from their profile page, e.g. `https://www.linkedin.com/in/their-name`). Leave Reply empty.
- [ ] Click the R icon. It shows your tab name. Settings say **"Saved and connected."**
- [ ] From the **second account**, send a message to **you**, e.g. "Test reply 1".
- [ ] Click the R icon → **Sync now**. The status shows "Syncing…" and then a summary.
- [ ] Within about a minute, the Reply cell in that row says `[27 Oct 2026, 11:42 AM] Test reply 1`, showing the date and time you sent it, not the time of the sync.
- [ ] Send "Test reply 2" from the second account, then click **Sync now** again. The cell now has two timestamped lines, oldest first, with a blank line between them and no `---`.
- [ ] Click **Sync now** once more without new messages. The cell doesn't change.
- [ ] From the second account, send "Test reply 1" again (the same text). After a sync, it is **not** added a second time.
- [ ] Check that **another team member's tab was not touched**, and that no other cell or column changed.
- [ ] Sign out of LinkedIn and click **Sync now**. A notification says *"LinkedIn is logged out — please sign in…"*, and nothing is written to the sheet. Sign back in.
- [ ] Turn off Wi-Fi and click **Sync now**. The popup says *"No internet connection — retrying automatically in 1 minute."* and nothing is written to the sheet. Turn Wi-Fi back on. Within about a minute, a sync runs by itself.
- [ ] Put the computer to sleep. Meanwhile, send "Test reply 3" from the second account. Wake the computer. Within about a minute, the reply appears in the sheet with the time it was sent.
- [ ] Restart the computer. Chrome opens by itself, and the pinned LinkedIn tab comes back.

---

## Part 6: If it stops working

**1. Look at the popup.** Click the R icon. The status box shows the last error in plain words:

| Message | What to do |
|---|---|
| `tab not found` | The tab name in Settings doesn't match the sheet. Fix the spelling. |
| `missing column: …` | Row 1 of your tab doesn't have that header. Fix the sheet or `Code.gs`. |
| `Apps Script returned a web page…` | The deployment isn't set to **Anyone**, the URL doesn't end in `/exec`, or the script has an error. |
| `LinkedIn is logged out` | Sign in to LinkedIn in Chrome. |
| `No internet connection — retrying in 1 minute` | Nothing to do. It tries again every minute until the connection is back. |
| `Couldn't read any conversation — LinkedIn's layout may have changed` | Update the selectors (below). |
| `The conversation list did not load` | Update `conversationList` / `conversationItem` (below). |

**2. Read the detailed log.** In the pinned LinkedIn tab, press **F12** (Mac: **Cmd+Option+I**) → **Console** tab → type `[ReplySync]` in the filter box. Every step is logged: each conversation, what was sent, and what was skipped and why. For the background part: `chrome://extensions` → ReplyTrack → **"service worker"** link → Console.

**3. Update the selectors when LinkedIn changes its page.** All page-specific settings are in the **`CONFIG`** block at the top of `extension/content.js`. Each entry is a list of CSS selectors that are tried in order.

1. Open `linkedin.com/messaging` in a normal tab.
2. Right-click the part that's no longer found, for example a conversation in the left list, the person's name above an open conversation, or one of their messages. Choose **Inspect**.
3. In the panel that opens, look at the highlighted element for something **stable**, like a readable class (`msg-…`), an `aria-label`, a `data-…` attribute, or a link pattern (`href*="/in/"`). Avoid random-looking classes like `ember123` or `_a1b2c`.
4. Test it: in the **Console** tab, run `document.querySelectorAll('YOUR SELECTOR').length`. It should match what you expect, e.g. one per conversation.
5. Add it to the **front** of the right list in `CONFIG.SELECTORS`, and keep the old ones after it:
   ```js
   conversationItem: [
       "li.new-linkedin-class",          // ← new one first
       "li.msg-conversation-listitem",   // old ones stay as fallbacks
       ...
   ```
6. Save the file. Go to `chrome://extensions` and click the **↻ reload** icon on ReplyTrack. Then click **Sync now**.

What each list is for:

| CONFIG entry | Finds |
|---|---|
| `conversationList`, `conversationItem` | the left-hand list and each conversation in it |
| `clickTarget` | what gets clicked to open a conversation |
| `itemName`, `itemTime` | name and "last activity" time on each conversation |
| `threadTitleBar`, `threadProfileLink`, `threadName` | the bar at the top of an open conversation, with the person's profile link |
| `messageList`, `messageEvent`, `messageItem`, `messageBody` | the messages and their text |
| `otherPersonMessage`, `senderLink`, `senderName` | how to tell *their* messages from *yours* |
| `dateHeading`, `messageTime` | when each message was sent: the date dividers ("Today", "Oct 12") and the time next to the sender's name. If these break, replies get the time they were *captured*, and the Console shows *"Couldn't read when … were sent"*. |
| `itemSponsoredLabel`, `itemGroupMarker` | what gets skipped |

After changing selectors, it's safe to use **Settings → Reset sync history** to re-check the last 50 conversations. Nothing already in the sheet gets duplicated.

---

## Good to know

- **Conversations get marked as read.** The extension opens conversations like you would, so LinkedIn marks them as read.
- **A profile view may show up.** LinkedIn's messaging page often shows profile links as a code (`/in/ACoAA…`) instead of the person's name link. To turn the code into the real link, the extension opens that profile in the background, once per person (it remembers the result), so LinkedIn may count it as a profile view.
- **Only rows in your tab are touched.** Replies from people who aren't in your tab are sent to the script, which ignores them (`profile not in tab`), and nothing is written. If you add that person to your tab later, their reply is filled in the next time they message you.
- **Group chats and sponsored/InMail messages are skipped.**
- **LinkedIn's rules:** LinkedIn's User Agreement restricts automated tools. This extension only reads your own inbox, slowly, while you're signed in. Still, using it is your team's decision and risk.
