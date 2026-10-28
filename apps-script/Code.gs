/**
 * ReplyTrack — Google Apps Script web app
 *
 * Every team member puts this script in THEIR OWN Google Sheet (Extensions → Apps Script)
 * and deploys it as their own web app. The Chrome extension only ever talks to that one
 * sheet, and only to the tab named in its settings.
 *
 * Every request is a POST with a JSON body:
 *   { "key": "<SECRET_KEY>", "tab": "MY LEADS", "action": "...", ... }
 * A request without the right key is rejected before anything is read or written.
 *
 * Actions
 *   ping                                         → checks the tab, the columns, the dropdown, write access
 *   read                                         → every row, all columns (for {placeholders})
 *   markSent     { profileUrl, sentAt }          → Outreach Status "Sent" + Sent Date (the day of sentAt;
 *                                                  no sentAt → Sent Date left empty)
 *   markAccepted { profileUrl }                  → "Accepted but not replied" in Response / Notes
 *   addReplies   { profileUrl, replies, sentAt } → their messages in Response / Notes; "Sent" → "Replied"
 *   clearAdmin   { profileUrl, row, adminText, notesText }
 *                                                → after an Admin Reply was seen in the LinkedIn
 *                                                  conversation: clears Admin Reply and Response / Notes
 *
 * Answer (JSON): { "ok": true, ... }  or  { "ok": false, "error": "..." }
 *   errors: "wrong key" | "set SECRET_KEY in Code.gs" | "tab not found" | "missing column: <name>"
 *         | "profile not in tab" | "cell full" | "admin reply changed — not cleared"
 *         | "bad request" | "busy, try again" | "error: ..."
 *
 * Safety rules — enforced here, whatever the extension asks:
 *   - Only these columns are ever written: Outreach Status, Sent Date, Response / Notes, and
 *     Admin Reply (only ever cleared, after a verified send). Every other column is read-only.
 *   - Outreach Status only ever gets "Sent" (from empty or "Not Started") or "Replied" (from "Sent"),
 *     and only if that value is in the cell's dropdown.
 *   - A cell with a formula is never written: it is skipped and logged. A column filled by one
 *     formula at the top (ARRAYFORMULA, IMPORTRANGE, QUERY, …) is never written at all.
 *   - Text in Response / Notes is never deleted or overwritten — new replies are added below it —
 *     except the exact text "Accepted but not replied", and the clear after a verified Admin Reply.
 *   - Clearing removes the contents only: formatting and dropdowns stay.
 *   - Columns are never added, removed or moved.
 */

// ============================================================================
// SETTINGS
// ============================================================================

// The shared secret key. Make up a long random one (16+ characters, e.g. from a password
// generator), paste it between the quotes, and enter the SAME key in the extension's settings.
// While this still says CHANGE-ME, every request is rejected.
var SECRET_KEY = 'CHANGE-ME';

// Headers in ROW 1 of the tab. Matching ignores upper/lower case and extra spaces.
var COLUMNS = {
  profile: 'LinkedIn Profile',      // read — https://www.linkedin.com/in/... links
  message: 'Personalized Message',  // read — the connection note
  status: 'Outreach Status',        // write — "Sent", "Replied" (a dropdown)
  sentDate: 'Sent Date',            // write
  notes: 'Response / Notes',        // write
  admin: 'Admin Reply',             // read — cleared only after a verified send
};
// The only columns this script may ever write to.
var WRITABLE = ['status', 'sentDate', 'notes', 'admin'];

var SENDABLE = ['', 'not started'];        // Outreach Status a connection request may be sent from
var SENT = 'Sent';
var REPLIED = 'Replied';
var ACCEPTED_TEXT = 'Accepted but not replied';

var DEFAULT_TIME_ZONE = 'Asia/Kolkata';   // used when the spreadsheet has no time zone set
var DATE_FORMAT = 'dd mmm yyyy';          // Sent Date, if the cell has no date format yet → 24 Oct 2026
var TIME_FORMAT = 'd MMM yyyy, h:mm a';   // reply times → 27 Oct 2026, 11:42 PM
var ENTRY_SEPARATOR = '\n\n';             // blank line between messages in one cell
var CELL_LIMIT = 50000;                   // Google Sheets maximum characters per cell
var LOCK_WAIT_MS = 30000;                 // how long a write waits for another one to finish

var PLACEHOLDER_KEY = 'CHANGE-ME';
var MIN_KEY_LENGTH = 16;

// "[27 Oct 2026, 11:42 PM] text" — one message in a Response / Notes cell.
var ENTRY_RE = /^\[(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}), (\d{1,2}):(\d{2}) ?([AP])\.?M\.?\] ?([\s\S]*)$/i;
// Where the next message starts: a blank line followed by "[27 Oct 2026, 11:42 PM]".
var ENTRY_START_RE = /\n[ \t]*\n(?=\[\d{1,2} [A-Za-z]{3,9}\.? \d{4}, \d{1,2}:\d{2} ?[AP]\.?M\.?\])/i;
// A formula that fills a whole column from one cell. Writing below it would break it.
var SPILL_RE = /^=\s*(ARRAYFORMULA|IMPORTRANGE|QUERY|FILTER|SORTN?|UNIQUE|FLATTEN|MAP|BYROW|BYCOL|SEQUENCE|TRANSPOSE|IMPORTDATA|IMPORTHTML|IMPORTXML|IMPORTFEED)\s*\(/i;

// ----------------------------------------------------------------------------
// Web app entry points
// ----------------------------------------------------------------------------

// Opening the web app URL in a browser shows this — handy to check the deployment. No data.
function doGet() {
  return ContentService.createTextOutput('ok — ReplyTrack web app is running');
}

var ACTIONS = {
  ping: { run: ping_, write: false },
  read: { run: read_, write: false },
  markSent: { run: markSent_, write: true },
  markAccepted: { run: markAccepted_, write: true },
  addReplies: { run: addReplies_, write: true },
  clearAdmin: { run: clearAdmin_, write: true },
};

function doPost(e) {
  var data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return out_({ ok: false, error: 'bad request' });
  }
  if (!data || typeof data !== 'object') return out_({ ok: false, error: 'bad request' });

  var keyProblem = checkKey_(data.key);
  if (keyProblem) {
    console.warn('[ReplySync] Request rejected: %s', keyProblem);
    return out_({ ok: false, error: keyProblem });
  }
  var action = ACTIONS[data.action];
  if (!action) return out_({ ok: false, error: 'bad request' });

  // Writes one at a time, so a reply and a status update can't collide.
  var lock = null;
  if (action.write) {
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (err) {
      return out_({ ok: false, error: 'busy, try again' });
    }
  }
  try {
    var ctx = open_(data.tab);
    if (typeof ctx === 'string') return out_({ ok: false, error: ctx });
    var result = action.run(ctx, data);
    if (action.write) {
      SpreadsheetApp.flush();
      console.log('%s %s %s -> %s', prefix_(data.action), data.action, data.profileUrl || '', JSON.stringify(result));
    }
    return out_(result);
  } catch (err) {
    console.error(prefix_(data.action) + ' ' + (err && err.stack ? err.stack : err));
    return out_({ ok: false, error: 'error: ' + (err && err.message ? err.message : err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function checkKey_(key) {
  var secret = String(SECRET_KEY || '');
  if (!secret || secret === PLACEHOLDER_KEY) return 'set SECRET_KEY in Code.gs';
  if (secret.length < MIN_KEY_LENGTH) return 'SECRET_KEY in Code.gs is too short (use 16 or more characters)';
  if (typeof key !== 'string' || key !== secret) return 'wrong key';
  return '';
}

function prefix_(action) {
  return action === 'markSent' || action === 'markAccepted' ? '[Outreach]' : '[ReplySync]';
}

// ----------------------------------------------------------------------------
// The tab and its columns
// ----------------------------------------------------------------------------

// -> { sheet, headers, col (1-based column numbers), lastRow, tz, cache } or an error string.
function open_(tabName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = findTab_(ss, tabName);
  if (!sheet) return 'tab not found';
  var lastCol = sheet.getLastColumn();
  var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  var col = {};
  for (var k in COLUMNS) {
    var i = findColumn_(headers, COLUMNS[k]);
    if (i < 0) return 'missing column: ' + COLUMNS[k];
    col[k] = i + 1;
  }
  return {
    sheet: sheet,
    headers: headers,
    col: col,
    lastRow: sheet.getLastRow(),
    tz: ss.getSpreadsheetTimeZone() || DEFAULT_TIME_ZONE,
    cache: {},
  };
}

function ping_(ctx) {
  var problems = [];
  WRITABLE.forEach(function (k) {
    if (spillColumn_(ctx, k)) problems.push('"' + COLUMNS[k] + '" is filled by a formula, so it is never written');
  });
  var edit = editProblem_(ctx);
  if (edit) problems.push(edit);
  return {
    ok: true,
    tab: ctx.sheet.getName(),
    rows: Math.max(0, ctx.lastRow - 1),
    timeZone: ctx.tz,
    statusValues: statusList_(ctx, 0) || [],
    problems: problems,
  };
}

// Every row, every column, as shown in the sheet. The profile column holds the link itself
// (also when the cell shows other text with the link behind it, or uses =HYPERLINK()).
function read_(ctx) {
  var n = Math.max(0, ctx.lastRow - 1);
  var rows = [];
  var sentMs = [];
  if (n) {
    rows = ctx.sheet.getRange(2, 1, n, ctx.headers.length).getDisplayValues();
    var urls = profiles_(ctx);
    var dates = ctx.sheet.getRange(2, ctx.col.sentDate, n, 1).getValues();
    for (var i = 0; i < n; i++) {
      rows[i][ctx.col.profile - 1] = urls[i];
      var d = dates[i][0];
      sentMs.push(d instanceof Date && !isNaN(d.getTime()) ? d.getTime() : null);
    }
  }
  return {
    ok: true,
    tab: ctx.sheet.getName(),
    timeZone: ctx.tz,
    header: ctx.headers,
    first: 2,
    rows: rows,
    sentMs: sentMs,
    statusValues: statusList_(ctx, 0) || [],
  };
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

// A connection request was sent (now, earlier, or found already pending): "Sent" + Sent Date,
// in every row of that person whose Outreach Status is still empty or "Not Started". Any
// other status is never touched. Without sentAt the Sent Date is left empty.
function markSent_(ctx, data) {
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var when = validTime_(data.sentAt);
  var written = [];
  var skipped = [];
  rows.forEach(function (row) {
    var statusCell = ctx.sheet.getRange(row, ctx.col.status);
    var current = statusCell.getDisplayValue();
    if (SENDABLE.indexOf(norm_(current)) < 0) return skipped.push({ row: row, why: 'Outreach Status is "' + current + '"' });
    var why = blocked_(ctx, row, 'status');
    if (why) return skip_(skipped, row, why, '[Outreach]');
    var value = allowed_(ctx, row, SENT);
    if (!value) return skip_(skipped, row, '"' + SENT + '" is not in the Outreach Status dropdown', '[Outreach]');
    statusCell.setValue(value);
    written.push(row);

    if (!when) return; // e.g. a request found already pending: date unknown
    var dateCell = ctx.sheet.getRange(row, ctx.col.sentDate);
    var dateWhy = blocked_(ctx, row, 'sentDate');
    if (dateWhy) skip_(skipped, row, dateWhy, '[Outreach]');
    else if (String(dateCell.getDisplayValue()).trim()) skipped.push({ row: row, why: 'Sent Date already filled — kept' });
    else writeDate_(dateCell, when, ctx.tz);
  });
  return { ok: true, written: written, skipped: skipped };
}

// They accepted: "Accepted but not replied" — only where Outreach Status is "Sent" and
// Response / Notes is empty.
function markAccepted_(ctx, data) {
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var written = [];
  var skipped = [];
  rows.forEach(function (row) {
    var status = ctx.sheet.getRange(row, ctx.col.status).getDisplayValue();
    if (norm_(status) !== norm_(SENT)) return skipped.push({ row: row, why: 'Outreach Status is "' + status + '"' });
    var cell = ctx.sheet.getRange(row, ctx.col.notes);
    if (String(cell.getDisplayValue()).trim()) return skipped.push({ row: row, why: 'Response / Notes is not empty' });
    var why = blocked_(ctx, row, 'notes');
    if (why) return skip_(skipped, row, why, '[Outreach]');
    setText_(cell, ACCEPTED_TEXT);
    written.push(row);
  });
  return { ok: true, written: written, skipped: skipped };
}

// Their messages, each as "[27 Oct 2026, 11:42 PM] text", oldest first, never twice.
// Empty cell or exactly "Accepted but not replied" → replaced. Anything else → kept exactly
// as it is (formatting too), and the new messages are added below it.
function addReplies_(ctx, data) {
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var replies = cleanReplies_(data.replies, data.sentAt);
  var now = new Date();
  var plans = [];
  var skipped = [];

  // Work out every change first; write only when all of them are fine.
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var why = blocked_(ctx, row, 'notes');
    if (why) {
      skip_(skipped, row, why, '[ReplySync]');
      continue;
    }
    var cell = ctx.sheet.getRange(row, ctx.col.notes);
    var shown = cell.getDisplayValue();
    var fresh = newReplies_(shown, replies);
    if (!fresh.length) continue; // every message is already in the cell
    var block = fresh
      .map(function (r) { return '[' + Utilities.formatDate(r.sentAt ? new Date(r.sentAt) : now, ctx.tz, TIME_FORMAT) + '] ' + r.text; })
      .join(ENTRY_SEPARATOR);
    var trimmed = String(shown).trim();
    var replace = !trimmed || trimmed === ACCEPTED_TEXT;
    if ((replace ? 0 : shown.length + ENTRY_SEPARATOR.length) + block.length > CELL_LIMIT) return { ok: false, error: 'cell full' };
    plans.push({ row: row, cell: cell, shown: shown, block: block, replace: replace, rich: replace ? null : cell.getRichTextValue() });
  }

  var written = [];
  plans.forEach(function (p) {
    if (p.replace) setText_(p.cell, p.block);
    else appendText_(p.cell, p.rich, p.shown, p.block);
    written.push(p.row);
    // They replied: "Sent" → "Replied". Any other status is never touched.
    var statusCell = ctx.sheet.getRange(p.row, ctx.col.status);
    if (norm_(statusCell.getDisplayValue()) !== norm_(SENT)) return;
    var why = blocked_(ctx, p.row, 'status');
    var value = allowed_(ctx, p.row, REPLIED);
    if (why) skip_(skipped, p.row, why, '[ReplySync]');
    else if (!value) skip_(skipped, p.row, '"' + REPLIED + '" is not in the Outreach Status dropdown', '[ReplySync]');
    else statusCell.setValue(value);
  });
  return { ok: true, written: written, skipped: skipped };
}

// The Admin Reply was seen in the LinkedIn conversation: clear Admin Reply and Response / Notes
// in that row (contents only — formatting and dropdowns stay). Only if the Admin Reply is still
// the text that was sent. Replies added to Response / Notes after the extension read it are kept.
function clearAdmin_(ctx, data) {
  var target = profileKey_(data.profileUrl);
  var wanted = norm_(data.adminText);
  if (!target || !wanted) return { ok: false, error: 'bad request' };
  var urls = profiles_(ctx);
  var matches = function (row) {
    return row >= 2 && row <= ctx.lastRow && profileKey_(urls[row - 2]) === target &&
      norm_(ctx.sheet.getRange(row, ctx.col.admin).getDisplayValue()) === wanted;
  };
  var row = Number(data.row);
  if (!matches(row)) {
    // The rows moved (sorting, inserted rows): find that person's row with that Admin Reply.
    var found = [];
    for (var r = 2; r <= ctx.lastRow; r++) if (matches(r)) found.push(r);
    if (found.length !== 1) return { ok: false, error: found.length ? 'several rows match — not cleared' : 'admin reply changed — not cleared' };
    row = found[0];
  }
  var why = blocked_(ctx, row, 'admin') || blocked_(ctx, row, 'notes');
  if (why) {
    console.warn('[ReplySync] Row %s not cleared: %s', row, why);
    return { ok: false, error: why };
  }
  ctx.sheet.getRange(row, ctx.col.admin).clearContent();

  var notes = ctx.sheet.getRange(row, ctx.col.notes);
  var now = lines_(notes.getDisplayValue());
  var was = lines_(data.notesText);
  var result = 'cleared';
  if (!now) result = 'empty';
  else if (now === was) notes.clearContent();
  else if (was && now.indexOf(was) === 0) {
    // New replies arrived after the extension read the cell: those stay.
    var rest = now.slice(was.length).replace(/^\s+/, '');
    if (rest) setText_(notes, rest);
    else notes.clearContent();
    result = 'kept newer replies';
  } else {
    result = 'not cleared — it changed since';
    console.warn('[ReplySync] Row %s: Response / Notes changed since it was read — left as it is.', row);
  }
  return { ok: true, row: row, notes: result };
}

// ----------------------------------------------------------------------------
// Write guards
// ----------------------------------------------------------------------------

// '' when this cell may be written, else the reason it may not.
function blocked_(ctx, row, key) {
  if (WRITABLE.indexOf(key) < 0) return '"' + COLUMNS[key] + '" is read-only';
  if (spillColumn_(ctx, key)) return '"' + COLUMNS[key] + '" is filled by a formula';
  if (ctx.sheet.getRange(row, ctx.col[key]).getFormula()) return '"' + COLUMNS[key] + '" has a formula in row ' + row;
  return '';
}

function skip_(list, row, why, prefix) {
  console.warn('%s Skipped row %s: %s', prefix, row, why);
  list.push({ row: row, why: why });
}

// Is a column filled from one formula (header row included)?
function spillColumn_(ctx, key) {
  var k = 'spill_' + key;
  if (!(k in ctx.cache)) {
    var f = ctx.sheet.getRange(1, ctx.col[key], Math.max(1, ctx.lastRow), 1).getFormulas();
    ctx.cache[k] = f.some(function (r) { return SPILL_RE.test(r[0]); });
  }
  return ctx.cache[k];
}

// The Outreach Status dropdown for one row (its own rule, else the column's first rule).
function statusList_(ctx, row) {
  if (row) {
    var own = listOf_(ctx.sheet.getRange(row, ctx.col.status).getDataValidation());
    if (own) return own;
  }
  if (!('statusList' in ctx.cache)) {
    var found = null;
    if (ctx.lastRow >= 2) {
      var rules = ctx.sheet.getRange(2, ctx.col.status, ctx.lastRow - 1, 1).getDataValidations();
      for (var i = 0; i < rules.length && !found; i++) found = listOf_(rules[i][0]);
    }
    ctx.cache.statusList = found;
  }
  return ctx.cache.statusList;
}

function listOf_(rule) {
  if (!rule) return null;
  var type = rule.getCriteriaType();
  var values = rule.getCriteriaValues();
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return (values[0] || []).map(String);
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && values[0]) {
    return [].concat.apply([], values[0].getDisplayValues()).filter(String);
  }
  return null;
}

// The dropdown's own spelling of `wanted`, or null when it isn't in the dropdown.
function allowed_(ctx, row, wanted) {
  var list = statusList_(ctx, row);
  if (!list) return null;
  for (var i = 0; i < list.length; i++) if (norm_(list[i]) === norm_(wanted)) return list[i];
  return null;
}

// Protected tab or cells this account can't edit (a warning-only protection doesn't count).
function editProblem_(ctx) {
  try {
    var mine = ctx.sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < mine.length; i++) {
      if (!mine[i].isWarningOnly() && !mine[i].canEdit()) return 'the tab is protected and this account may not be able to write to it';
    }
    var ranges = ctx.sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    for (var j = 0; j < ranges.length; j++) {
      var p = ranges[j];
      if (p.isWarningOnly() || p.canEdit()) continue;
      var rg = p.getRange();
      for (var w = 0; w < WRITABLE.length; w++) {
        var c = ctx.col[WRITABLE[w]];
        if (rg.getColumn() <= c && c <= rg.getLastColumn()) return 'cells in "' + COLUMNS[WRITABLE[w]] + '" are protected and this account can\'t edit them';
      }
    }
  } catch (err) {
    console.warn('[ReplySync] Could not read the protections: %s', err);
  }
  return '';
}

// ----------------------------------------------------------------------------
// Cells
// ----------------------------------------------------------------------------

// Text is stored exactly as given: never turned into a formula, number or date.
function setText_(cell, text) {
  cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(text).build());
}

// Adds text below what's in the cell, keeping the existing text and its formatting exactly.
function appendText_(cell, rich, shown, addition) {
  var base = rich ? rich.getText() : String(shown || '');
  var sep = /\n\n$/.test(base) ? '' : /\n$/.test(base) ? '\n' : ENTRY_SEPARATOR;
  var builder = SpreadsheetApp.newRichTextValue().setText(base + sep + addition);
  if (rich) {
    rich.getRuns().forEach(function (run) {
      var s = run.getStartIndex();
      var e = run.getEndIndex();
      if (e <= s) return;
      builder.setTextStyle(s, e, run.getTextStyle());
      if (run.getLinkUrl()) builder.setLinkUrl(s, e, run.getLinkUrl());
    });
  }
  cell.setRichTextValue(builder.build());
}

// A real date (midnight in the sheet's time zone), shown like the other Sent Dates.
function writeDate_(cell, ms, tz) {
  var day = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
  var format = String(cell.getNumberFormat() || '').replace(/"[^"]*"/g, '');
  if (!/[dy]/i.test(format)) cell.setNumberFormat(DATE_FORMAT);
  cell.setValue(Utilities.parseDate(day, tz, 'yyyy-MM-dd'));
}

// Messages not in the cell yet (by text), oldest first.
function newReplies_(cellText, replies) {
  var seen = {};
  String(cellText || '').replace(/\r\n?/g, '\n').split(ENTRY_START_RE).forEach(function (chunk) {
    var m = chunk.trim().match(ENTRY_RE);
    if (m) seen[norm_(m[7])] = true;
  });
  var fresh = [];
  replies.forEach(function (r) {
    var k = norm_(r.text);
    if (!k || seen[k]) return;
    seen[k] = true;
    fresh.push(r);
  });
  return fresh.sort(function (a, b) { return (a.sentAt || Infinity) - (b.sentAt || Infinity); });
}

// ----------------------------------------------------------------------------
// Rows and profile links
// ----------------------------------------------------------------------------

// The link in each row's LinkedIn Profile cell (row 2 first).
function profiles_(ctx) {
  if (ctx.cache.profiles) return ctx.cache.profiles;
  var n = Math.max(0, ctx.lastRow - 1);
  var out = [];
  if (n) {
    var range = ctx.sheet.getRange(2, ctx.col.profile, n, 1);
    var shown = range.getDisplayValues();
    var rich = range.getRichTextValues();
    var formulas = range.getFormulas();
    for (var i = 0; i < n; i++) out.push(profileUrl_(shown[i][0], rich[i][0], formulas[i][0]));
  }
  return (ctx.cache.profiles = out);
}

// The text itself, a link behind other text, or the URL inside =HYPERLINK().
function profileUrl_(shown, rich, formula) {
  if (profileKey_(shown)) return String(shown).trim();
  if (rich) {
    if (profileKey_(rich.getLinkUrl())) return rich.getLinkUrl();
    var runs = rich.getRuns();
    for (var r = 0; r < runs.length; r++) if (profileKey_(runs[r].getLinkUrl())) return runs[r].getLinkUrl();
  }
  var m = String(formula || '').match(/https?:\/\/[^"\s)]+/i);
  if (m && profileKey_(m[0])) return m[0];
  return String(shown || '').trim();
}

// Row numbers whose LinkedIn Profile is this person.
function rowsFor_(ctx, profileUrl) {
  var target = profileKey_(profileUrl);
  if (!target) return [];
  var urls = profiles_(ctx);
  var rows = [];
  for (var i = 0; i < urls.length; i++) if (profileKey_(urls[i]) === target) rows.push(i + 2);
  return rows;
}

// "https://www.linkedin.com/in/Jane-Doe-123/?trk=x" -> "jane-doe-123"
// Ignores http/https, www (or country subdomains), trailing slashes, query strings,
// #fragments and URL encoding (%C3%A9 -> é). Case-insensitive.
function profileKey_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  for (var i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    try {
      s = decodeURIComponent(s);
    } catch (err) {
      break;
    }
  }
  var m = s.match(/linkedin\.com\/(?:mwlite\/)?in\/([^\/?#\s"']+)/i) || s.match(/linkedin\.com\/sales\/(?:lead|people)\/(AC[wo]AA[\w-]+)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function findTab_(ss, name) {
  var wanted = String(name || '').trim();
  if (!wanted) return null;
  var exact = ss.getSheetByName(wanted);
  if (exact) return exact;
  var lower = wanted.toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === lower) return sheets[i];
  }
  return null;
}

function findColumn_(headers, name) {
  var wanted = headerKey_(name);
  for (var i = 0; i < headers.length; i++) {
    if (headerKey_(headers[i]) === wanted) return i;
  }
  return -1;
}

function headerKey_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// -> [{ text, sentAt }] ; sentAt is null when missing or not a sensible time.
function cleanReplies_(list, times) {
  if (!Array.isArray(list)) return [];
  var out = [];
  list.forEach(function (r, i) {
    var isObject = r !== null && typeof r === 'object';
    var raw = isObject ? r.text : r;
    var t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!t) return;
    out.push({ text: t, sentAt: validTime_(isObject ? r.sentAt : Array.isArray(times) ? times[i] : NaN) });
  });
  return out;
}

// Milliseconds between 2003 (LinkedIn's launch) and one day ahead (clock differences), else null.
function validTime_(v) {
  var ms = Number(v);
  return isFinite(ms) && ms > 1041379200000 && ms < Date.now() + 86400000 ? ms : null;
}

// For duplicate checks: whitespace and case don't matter; a leading ' is ignored.
function norm_(s) {
  return String(s || '').replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function lines_(s) {
  return String(s || '').replace(/\r\n?/g, '\n').trim();
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------------------
// Run this once from the editor (select "testSetup" → Run) to check your set-up.
// Results appear in the "Execution log" at the bottom of the editor. Read-only.
// ----------------------------------------------------------------------------
function testSetup() {
  var keyProblem = checkKey_(SECRET_KEY);
  console.log('Secret key: %s', keyProblem ? 'NOT READY — ' + keyProblem : 'set');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  console.log('Time zone used for dates and reply times: %s', ss.getSpreadsheetTimeZone() || DEFAULT_TIME_ZONE + ' (the spreadsheet has none set)');
  ss.getSheets().forEach(function (sheet) {
    var ctx = open_(sheet.getName());
    if (typeof ctx === 'string') {
      console.log('Tab "%s": not usable — %s', sheet.getName(), ctx);
      return;
    }
    var p = ping_(ctx);
    console.log('Tab "%s": %s rows, all columns found. Outreach Status dropdown: %s%s',
      sheet.getName(), p.rows, p.statusValues.join(' | ') || 'NONE',
      p.problems.length ? ' | Problems: ' + p.problems.join('; ') : '');
  });
}
