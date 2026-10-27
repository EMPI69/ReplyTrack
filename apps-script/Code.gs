/**
 * ReplyTrack — Google Apps Script web app
 *
 * Receives replies from the Chrome extension and writes them into the
 * "Reply" column of the matching row in the team member's tab.
 *
 * Request (POST body, JSON):
 *   { "tab": "John", "profileUrl": "https://www.linkedin.com/in/jane-doe",
 *     "name": "Jane Doe",
 *     "replies": ["Thanks for reaching out!", "Tuesday works"],
 *     "sentAt":  [1793123520000, 1793123700000] }
 *   sentAt[i] = when the person sent replies[i] on LinkedIn (milliseconds since 1970).
 *   A missing or unusable time is replaced by the time the request arrives.
 *   (replies may also be [{ "text": "...", "sentAt": 1793123520000 }].)
 *
 * Each message is written as "[27 Oct 2026, 11:42 PM] message text" in the
 * spreadsheet's time zone, oldest first, with a blank line between messages.
 *
 * The ONLY thing ever written to the sheet is that text, in the Reply column.
 * Errors and statuses are only returned to the extension, never written.
 *
 * Response (plain text): "ok" | "tab not found" | "profile not in tab"
 *   | "missing column: <name>" | "cell full" | "bad request" | "busy, try again" | "error: ..."
 *
 * Connection test from the extension's settings page:
 *   { "action": "ping", "tab": "John" }  ->  "ok" | "tab not found" | "missing column: ..."
 */

// ============================================================================
// SETTINGS — make these match the headers in ROW 1 of every team member's tab.
// Matching ignores upper/lower case and extra spaces.
// (The Note column is never read or changed, so it is not listed here.)
// ============================================================================
var PROFILE_HEADER = 'Profile URL'; // column with https://www.linkedin.com/in/... links
var REPLY_HEADER = 'Reply';         // column the replies are written into

var TIME_FORMAT = 'd MMM yyyy, h:mm a'; // -> 27 Oct 2026, 11:42 PM (spreadsheet's time zone)
var ENTRY_SEPARATOR = '\n\n';           // blank line between messages in one cell
var CELL_LIMIT = 50000;                 // Google Sheets maximum characters per cell
var LOCK_WAIT_MS = 30000;               // how long a request waits for another to finish

// "[27 Oct 2026, 11:42 PM] text" — one message in a Reply cell.
// (Also accepts "Sept" / "p.m." in case Google formats dates that way.)
var ENTRY_RE = /^\[(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}), (\d{1,2}):(\d{2}) ?([AP])\.?M\.?\] ?([\s\S]*)$/i;
// Where the next message starts: a blank line followed by "[27 Oct 2026, 11:42 PM]".
var ENTRY_START_RE = /\n[ \t]*\n(?=\[\d{1,2} [A-Za-z]{3,9}\.? \d{4}, \d{1,2}:\d{2} ?[AP]\.?M\.?\])/i;
var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ----------------------------------------------------------------------------
// Web app entry points
// ----------------------------------------------------------------------------

// Opening the web app URL in a browser shows this — handy to check the deployment.
function doGet() {
  return out_('ok — ReplyTrack web app is running');
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return out_('bad request');
  }
  if (!data || typeof data !== 'object') return out_('bad request');

  // One request at a time, so two team members syncing at once can't collide.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    return out_('busy, try again');
  }
  try {
    var status = handle_(data);
    console.log('[ReplySync] tab=%s profile=%s replies=%s -> %s',
      data.tab, data.profileUrl, (data.replies || []).length, status);
    return out_(status);
  } catch (err) {
    console.error('[ReplySync] ' + (err && err.stack ? err.stack : err));
    return out_('error: ' + (err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// Main logic
// ----------------------------------------------------------------------------

function handle_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = findTab_(ss, data.tab);
  if (!sheet) return 'tab not found';

  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (lastCol < 1 || lastRow < 1) return 'missing column: ' + PROFILE_HEADER;

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var profileCol = findColumn_(headers, PROFILE_HEADER);
  var replyCol = findColumn_(headers, REPLY_HEADER);
  if (profileCol < 0) return 'missing column: ' + PROFILE_HEADER;
  if (replyCol < 0) return 'missing column: ' + REPLY_HEADER;

  if (data.action === 'ping') return 'ok';

  var target = slug_(data.profileUrl);
  if (!target || lastRow < 2) return 'profile not in tab';

  // Read the whole profile column once. A cell can hold the URL as plain text,
  // as a link behind other text, or inside a =HYPERLINK() formula — check all three.
  var range = sheet.getRange(2, profileCol + 1, lastRow - 1, 1);
  var shown = range.getDisplayValues();
  var rich = range.getRichTextValues();
  var formulas = range.getFormulas();

  var replies = cleanReplies_(data.replies, data.sentAt);
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  var matched = 0;
  var updates = [];

  // Work out every change first; write only when all of them are fine.
  // If anything fails before this point, the sheet is left untouched.
  for (var i = 0; i < shown.length; i++) {
    if (!rowMatches_(target, shown[i][0], rich[i][0], formulas[i][0])) continue;
    matched++;
    if (!replies.length) continue;

    var cell = sheet.getRange(i + 2, replyCol + 1);
    var updated = merge_(cell.getDisplayValue(), replies, tz, now);
    if (updated === null) continue; // every message is already in the cell
    if (updated.length > CELL_LIMIT) return 'cell full';
    updates.push({ cell: cell, text: updated });
  }
  if (!matched) return 'profile not in tab';

  // Rich text is stored exactly as given: never turned into a formula, number or date.
  updates.forEach(function (u) {
    u.cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(u.text).build());
  });
  return 'ok';
}

function rowMatches_(target, shownText, richValue, formula) {
  if (slug_(shownText) === target) return true;
  if (richValue) {
    if (slug_(richValue.getLinkUrl()) === target) return true;
    var runs = richValue.getRuns();
    for (var r = 0; r < runs.length; r++) {
      if (slug_(runs[r].getLinkUrl()) === target) return true;
    }
  }
  if (formula && slug_(formula) === target) return true;
  return false;
}

// Adds messages whose text isn't in the cell yet, then orders everything oldest
// first. Returns the new cell text, or null when nothing is new.
function merge_(existing, replies, tz, now) {
  var entries = parseCell_(existing);
  var seen = {};
  entries.forEach(function (entry) {
    seen[norm_(entry.text)] = true;
  });

  var added = 0;
  replies.forEach(function (reply) {
    var k = norm_(reply.text);
    if (!k || seen[k]) return;
    seen[k] = true;
    entries.push(newEntry_(reply, tz, now));
    added++;
  });
  if (!added) return null;

  // Oldest first. Text without a timestamp stays at the top in its original order.
  var ordered = entries
    .map(function (entry, index) { return { entry: entry, index: index }; })
    .sort(function (a, b) {
      if (a.entry.key !== b.entry.key) return a.entry.key < b.entry.key ? -1 : 1;
      return a.index - b.index;
    })
    .map(function (x) { return x.entry.line; });
  return ordered.join(ENTRY_SEPARATOR);
}

// Splits a Reply cell into messages: { line, text, key } where key sorts by time.
function parseCell_(cellText) {
  var s = String(cellText || '').replace(/\r\n?/g, '\n').trim();
  if (!s) return [];
  var entries = [];
  s.split(ENTRY_START_RE).forEach(function (chunk) {
    chunk = chunk.trim();
    if (!chunk) return;
    var m = chunk.match(ENTRY_RE);
    if (m) {
      entries.push({ line: chunk, text: m[7], key: keyFromStamp_(m) });
      return;
    }
    // Text without a timestamp (e.g. written by the first version, which used "---").
    chunk.split(/\n-{3,}\n/).forEach(function (part) {
      part = part.trim();
      if (part) entries.push({ line: part, text: part, key: '' });
    });
  });
  return entries;
}

function newEntry_(reply, tz, now) {
  var date = reply.sentAt ? new Date(reply.sentAt) : now;
  return {
    line: '[' + Utilities.formatDate(date, tz, TIME_FORMAT) + '] ' + reply.text,
    text: reply.text,
    key: Utilities.formatDate(date, tz, 'yyyyMMddHHmm'),
  };
}

// "[27 Oct 2026, 11:42 PM]" parts -> "202610272342" (same sort key as newEntry_).
function keyFromStamp_(m) {
  var month = MONTHS[m[2].slice(0, 3).toLowerCase()] || 0;
  var hour = Number(m[4]) % 12 + (m[6].toUpperCase() === 'P' ? 12 : 0);
  return m[3] + pad2_(month) + pad2_(Number(m[1])) + pad2_(hour) + m[5];
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// "https://www.linkedin.com/in/Jane-Doe-123/?trk=x" -> "jane-doe-123"
// Ignores http/https, www (or country subdomains), trailing slashes, query
// strings, #fragments and URL encoding (%C3%A9 -> é). Case-insensitive.
function slug_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  for (var i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    try {
      s = decodeURIComponent(s);
    } catch (err) {
      break;
    }
  }
  var m = s.match(/linkedin\.com\/(?:mwlite\/)?in\/([^\/?#\s"']+)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

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
    var ms = Number(isObject ? r.sentAt : Array.isArray(times) ? times[i] : NaN);
    // Accept 2003 (LinkedIn's launch) up to one day ahead (clock differences).
    var ok = isFinite(ms) && ms > 1041379200000 && ms < Date.now() + 86400000;
    out.push({ text: t, sentAt: ok ? ms : null });
  });
  return out;
}

// For duplicate checks: whitespace and case don't matter; a leading ' is ignored.
function norm_(s) {
  return String(s || '').replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function out_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

// ----------------------------------------------------------------------------
// Run this once from the editor (select "testSetup" → Run) to check every tab.
// Results appear in the "Execution log" at the bottom of the editor. Read-only.
// ----------------------------------------------------------------------------
function testSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  console.log('Spreadsheet time zone (used for reply times): %s', ss.getSpreadsheetTimeZone());
  ss.getSheets().forEach(function (sheet) {
    var lastCol = sheet.getLastColumn();
    var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
    var p = findColumn_(headers, PROFILE_HEADER);
    var r = findColumn_(headers, REPLY_HEADER);
    var rows = Math.max(0, sheet.getLastRow() - 1);
    console.log('Tab "%s": %s rows | "%s" column: %s | "%s" column: %s',
      sheet.getName(), rows,
      PROFILE_HEADER, p >= 0 ? 'found' : 'MISSING',
      REPLY_HEADER, r >= 0 ? 'found' : 'MISSING');
  });
}
