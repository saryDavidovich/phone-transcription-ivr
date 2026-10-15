const express = require('express');
const crypto = require('crypto');
const { YemotRouter, HangupError } = require('yemot-router2');
const axios = require('axios');

const app = express();
// נדרש רק עבור נקודת הקצה הפנימית /internal/download-page (JSON body) -
// לא אמור להשפיע על נתיבי ה-Yemot עצמם, שהם GET בלי body.
app.use(express.json({ limit: '2mb' }));

const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';

// --- מפתח משותף מול שרת הפייתון (API_SHARED_SECRET) ---
// כשהמשתנה מוגדר גם כאן וגם בשרת הפייתון, כל קריאה לשרת הפייתון נושאת אותו בכותרת
// X-API-Key, ושרת הפייתון דוחה כל קריאה ל-/api בלי המפתח. ההוספה נעשית *רק* לכתובות
// של שרת הפייתון - ולעולם לא לשרתים אחרים (למשל call2all של ימות), כדי שהמפתח לא יזלוג.
const API_SHARED_SECRET = process.env.API_SHARED_SECRET || '';
axios.interceptors.request.use((config) => {
    const url = String(config.url || '');
    if (API_SHARED_SECRET && url.startsWith(PYTHON_URL + '/')) {
        config.headers = config.headers || {};
        config.headers['X-API-Key'] = API_SHARED_SECRET;
    }
    return config;
});

// --- proxy שקוף להורדת הקלטות דרך הפייתון - ראו הסבר מפורט מעל
// app.post('/internal/download-page', ...) למטה, ו"עדכון 5" ב-
// routes/recording_proxy.py בפרויקט הפייתון (phone-transcription). ---
const INTERNAL_PROXY_SECRET = process.env.INTERNAL_PROXY_SECRET || '';
const YEMOT_TOKEN = process.env.YEMOT_TOKEN || '';

function checkInternalSecret(req, res) {
    const provided = req.get('X-Internal-Secret') || '';
    const expected = INTERNAL_PROXY_SECRET;
    const ok = !!expected && provided.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
        res.status(403).json({ error: 'forbidden' });
        return false;
    }
    return true;
}

function escapeHtmlForDownloadPage(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function buildDataUriDownloadPage(filename, mimetype, b64) {
    const safeTitle = 'ההקלטה מוכנה להורדה';
    const safeFilename = escapeHtmlForDownloadPage(filename);
    return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; background:#f8fafc; display:flex;
         align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#fff; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,.08);
          padding:32px 28px; text-align:center; max-width:420px; }
  h2 { color:#1d4ed8; margin:0 0 8px; }
  p { color:#6b7280; margin:0 0 20px; word-break:break-word; }
  a.btn { display:inline-block; background:#ea580c; color:#fff; font-weight:700;
          padding:12px 28px; border-radius:8px; text-decoration:none; font-size:16px; }
  a.btn:hover { background:#c2410c; }
</style>
</head>
<body>
<div class="card">
  <h2>${safeTitle}</h2>
  <p>${safeFilename}</p>
  <a id="dl" class="btn" href="data:${mimetype};base64,${b64}" download="${safeFilename}">⬇️ להורדה לחצו כאן</a>
</div>
<script>
  document.getElementById('dl').click();
</script>
</body>
</html>`;
}

// מפענח כותרת WAV (RIFF/WAVE) ומחזיר { declaredDataBytes, byteRate } או
// null אם זה לא נראה כמו WAV תקין. משמש גם לבדיקת "נקטע באמצע השליחה"
// (declaredDataBytes > מה שבאמת קיבלנו) וגם לחישוב האורך בפועל בשניות.
function parseWavHeader(buf) {
    try {
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
            return null;
        }
        let pos = 12;
        let byteRate = null;
        while (pos + 8 <= buf.length) {
            const chunkId = buf.toString('ascii', pos, pos + 4);
            const chunkSize = buf.readUInt32LE(pos + 4);
            if (chunkId === 'fmt ' && pos + 8 + 16 <= buf.length) {
                byteRate = buf.readUInt32LE(pos + 8 + 8); // בתים/שנייה - offset 8 בתוך ה-fmt chunk
            }
            if (chunkId === 'data') {
                return { declaredDataBytes: chunkSize, dataStart: pos + 8, byteRate };
            }
            pos += 8 + chunkSize + (chunkSize % 2);
        }
    } catch (e) {
        return null;
    }
    return null;
}

// בודק אם קובץ ה-WAV חסר בייטים ביחס למה שהכותרת שלו מצהירה - סימן ל"נחתך
// באמצע השליחה" (אותה בדיקה בדיוק כמו _wav_looks_truncated בפייתון).
function wavLooksTruncated(buf) {
    const h = parseWavHeader(buf);
    if (!h) return false;
    const declaredEnd = h.dataStart + h.declaredDataBytes;
    return declaredEnd > buf.length + 1024; // 1KB סלאק ל-padding
}

// מחשב את אורך ההקלטה בפועל בשניות, לפי בתים שבאמת קיימים ב-data chunk
// (לא לפי מה שהכותרת מצהירה - כדי לתפוס גם מקרה שהכותרת "משקרת" בעצמה).
function wavActualDurationSeconds(buf) {
    const h = parseWavHeader(buf);
    if (!h || !h.byteRate) return null;
    const actualDataBytes = Math.min(h.declaredDataBytes, buf.length - h.dataStart);
    if (actualDataBytes <= 0) return null;
    return actualDataBytes / h.byteRate;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// מנסה להביא הקלטה מכתובת נתונה, עם עד 3 ניסיונות (עם המתנה גוברת בין
// ניסיון לניסיון) אם הקובץ שחוזר נראה בעייתי - או "נחתך באמצע" (WAV עם
// data chunk שגדול ממה שבאמת קיבלנו), או קצר משמעותית מהאורך האמיתי של
// השיחה (expectedDurationSeconds, אם ידוע - מגיע מ-Recording.duration_seconds
// בפייתון). הבדיקה השנייה קיימת כי עלה חשד (מהמשתמש) שימות המשיח עצמם
// לא תמיד מספיקים "לסיים לכתוב" את קובץ ההקלטה באותו הרגע שבו כבר אפשר
// לבקש אותו - אז ממתינים קצת ומנסים שוב במקום לוותר על ה-4 השניות הראשונות
// בלבד. מחזיר { buf, mimetype } עם התוצאה הכי טובה שהתקבלה (גם אם עדיין
// לא מושלמת - עדיף להחזיר קובץ חלקי מאשר שגיאה גמורה), או null אם שום
// ניסיון לא החזיר כלום.
async function fetchOnceWithRetries(url, expectedDurationSeconds, label) {
    const MAX_ATTEMPTS = 3;
    const DELAYS_MS = [0, 2000, 4000];
    let best = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (DELAYS_MS[attempt - 1]) await sleep(DELAYS_MS[attempt - 1]);
        let r;
        try {
            r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
        } catch (e) {
            console.error(`fetchOnceWithRetries [${label}] attempt ${attempt}: request failed:`, e.message);
            continue;
        }
        const buf = Buffer.from(r.data);
        const mimetype = r.headers['content-type'] || 'audio/wav';
        const declaredLen = r.headers['content-length'];
        const truncated = wavLooksTruncated(buf);
        const actualDuration = wavActualDurationSeconds(buf);
        const shortOfExpected = expectedDurationSeconds &&
            actualDuration != null && actualDuration < expectedDurationSeconds - 2;

        console.log(`fetchOnceWithRetries [${label}] attempt ${attempt}: declared Content-Length=` +
            `${declaredLen}, actual received=${buf.length} bytes, wav duration=${actualDuration}s, ` +
            `expected duration=${expectedDurationSeconds}s, looks_truncated=${truncated}, ` +
            `short_of_expected=${shortOfExpected}`);

        if (!best || buf.length > best.buf.length) {
            best = { buf, mimetype };
        }
        if (!truncated && !shortOfExpected) {
            return { buf, mimetype }; // הכי טוב שאפשר - קובץ תקין ובאורך המצופה
        }
        // אחרת ממשיכים לניסיון הבא (עם המתנה) - אולי ימות עדיין לא סיימו
        // לכתוב את הקובץ, או שהחיבור נחתך באופן חד-פעמי.
    }
    return best; // אף ניסיון לא היה מושלם - מחזירים את הכי טוב שהיה (או null)
}

async function fetchRecordingBytesForDownload(url, callId, expectedDurationSeconds) {
    // ניסיון ראשון: הכתובת שהתקבלה מהפייתון (rec.rec_url) - אותה כתובת
    // שהוכח בצד הפייתון (routes/recording_proxy.py) שמביאה תמיד את כל
    // הבייטים בשלמותם (הבעיה שם הייתה בשליחה החוצה ללקוח, לא בשליפה הזו -
    // אבל כאן, בצד הנוד, זו שליפה חדשה משלו, אז כן שווה לוודא).
    if (url) {
        const result = await fetchOnceWithRetries(url, expectedDurationSeconds, 'primary-url');
        if (result) return result;
    }
    // גיבוי: בניית כתובת DownloadFile עצמאית עם הטוקן של ימות, בדיוק כמו
    // הגיבוי המקביל בצד הפייתון (ובדיוק כמו שאר הקוד בקובץ הזה משתמש ב-
    // YEMOT_TOKEN, ראו למשל getEmailByVoice למעלה).
    if (callId && YEMOT_TOKEN) {
        const fallbackUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${YEMOT_TOKEN}` +
            `&path=ivr2:/recordings/${callId}.wav`;
        const result = await fetchOnceWithRetries(fallbackUrl, expectedDurationSeconds, 'fallback-url');
        if (result) return result;
    }
    return null;
}

// נקודת קצה פנימית בלבד (שרת-לשרת, לעולם לא נחשפת ללקוח קצה - מוגנת בסוד
// משותף ב-X-Internal-Secret) - הפייתון (phone-transcription) קורא לה כדי
// להעביר לכאן את בניית עמוד ההורדה של הקלטה (שליפה מימות + הטמעת הקובץ
// כ-data: URI), ואז מזרים (streaming, בלי לבנות מחדש בזיכרון) את מה
// שהיא מחזירה ישירות ללקוח, תחת הדומיין של הפייתון עצמו - כדי שנטפרי
// (שכבר סומכת על דומיין הפייתון) לעולם לא תראה/תצטרך לסמוך על הדומיין
// הזה כלל; הלקוח בדפדפן אף פעם לא פונה לכתובת הזו ישירות.
//
// למה זה קיים: הוכח בפועל (routes/recording_proxy.py בפרויקט הפייתון)
// שתגובות HTTP "כבדות" (עמוד עם קובץ מוטמע כ-base64) שהפייתון בונה ושולח
// בעצמו יוצאות קצוצות ללקוח הסופי - למרות שהשליפה מימות המשיח עצמה תמיד
// מגיעה שלמה (מאומת בלוגים). הפרויקט הזה (Node/Express, אותו Railway) לא
// סבל מאותה תופעה בפרויקט נפרד (הפורומים) עבור תבנית תגובה זהה (data:
// URI). כאן הנוד בונה את העמוד המלא, והפייתון רק מזרים אותו הלאה ללא
// buffering מלא - זה השינוי הארכיטקטוני שנועד לעקוף את הבעיה.
app.post('/internal/download-page', async (req, res) => {
    if (!checkInternalSecret(req, res)) return;
    const { url, filename, call_id: callId, expected_duration_seconds: expectedDurationSeconds } = req.body || {};
    if (!url && !callId) {
        return res.status(400).json({ error: 'missing url or call_id' });
    }
    const fetched = await fetchRecordingBytesForDownload(url, callId, expectedDurationSeconds);
    if (!fetched) {
        return res.status(502).json({ error: 'upstream fetch failed' });
    }
    const b64 = fetched.buf.toString('base64');
    const page = buildDataUriDownloadPage(filename || 'recording.wav', fetched.mimetype, b64);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(page);
});

const router = YemotRouter({
    printLog: true,
    // המנגנון הרשמי של הספרייה: כל שגיאה שלא טופלה בקוד שלנו (שאינה ניתוק/טיימאאוט/יציאה,
    // שהספרייה כבר מטפלת בהן לבד) מגיעה לכאן במקום להיזרק מחדש ולהפיל את כל השרת.
    uncaughtErrorHandler: async (error, call) => {
        console.error(`💥 Uncaught error in call ${call?.callId || ''} (server stays alive):`, error.message);
        // בכוונה לא עושים פה שום פעולה נוספת על call - היא עלולה להיות כבר לא תקינה
        // (לדוגמה response שכבר נשלח), וכל ניסיון נוסף עלול לזרוק שגיאה חדשה.
    }
});

// בודק אם שגיאה נגרמה מכך שהמתקשר ניתק את השיחה.
// במקרה כזה אסור לנסות לשלוח/לקרוא עוד דבר דרך call - החיבור כבר לא קיים.
function isHangup(e) {
    return e instanceof HangupError || e?.name === 'HangupError' || /hangup/i.test(e?.message || '');
}

function yemotDownloadUrl(path) {
    if (!path || path.startsWith('http')) return path;
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${clean}`;
}

function isTimeout(e) {
    return e?.name === 'TimeoutError';
}

// ---------------------------------------------------------------------------
// הקלטה עם תפריט אחרי סולמית (הודעה 150):
//   1 - שמירה ושליחה לתמלול
//   2 - הקלטה מחדש: מקליטים שוב לאותו קובץ (הקודם מוחלף)
//   3 - המשך הקלטה: ימות מוסיפה את ההמשך לסוף אותו קובץ (append_to_existing_file),
//       כך שבסוף יש קובץ אחד = הקלטה אחת, מייל אחד וחיוב אחד לפי האורך הכולל.
// ההקלטה הראשונה נשמרת כרגיל במספור הרץ של ימות (למשל /recordings/051.wav),
// ורק ההמשך/ההקלטה מחדש משתמשים באותו מספר.
// ניתוק או שתיקה ארוכה בתפריט = כמו "1" (שליחה), בדיוק כמו "לסיום נתק" היום.
// ---------------------------------------------------------------------------
async function recordWithMenu(call, phone, customer, opts) {
    let recPath = null;      // הנתיב שימות החזירה בהקלטה הראשונה
    let fileName = null;     // מספר הקובץ (בלי סיומת) - להמשך/הקלטה מחדש
    let append = false;
    let intro = MSG(23);     // 023 - השאר את הודעתך לאחר הצליל, לסיום הקש סולמית או נתק
    try {
        while (true) {
            const recOpts = { no_confirm_menu: true, save_on_hangup: true, path: '/recordings' };
            if (fileName) {
                recOpts.file_name = fileName;
                recOpts.append_to_existing_file = append;
            }
            const got = await call.read([intro], 'record', recOpts);
            if (!recPath) {
                recPath = (typeof got === 'string' && got) ? got : null;
                const m = recPath && recPath.match(/([^/]+)\.wav$/i);
                fileName = m ? m[1] : null;
            }
            if (!fileName) return recPath;   // לא הצלחנו לזהות את שם הקובץ - שולחים כמו פעם

            const choice = await call.read([
                MSG(150)  // 150 - לשמירת ההקלטה ושליחה לתמלול הקישו 1, להקלטה מחדש הקישו 2, להמשך ההקלטה הקישו 3
            ], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3], timeout: 120000 });

            if (choice === '2') {
                append = false;
                intro = MSG(151);  // 151 - הקליטו מחדש לאחר הצליל, בסיום הקישו סולמית
                continue;
            }
            if (choice === '3') {
                append = true;
                intro = MSG(152);  // 152 - המשיכו להקליט לאחר הצליל, בסיום הקישו סולמית
                continue;
            }
            return recPath;
        }
    } catch (e) {
        if ((isHangup(e) || isTimeout(e)) && recPath) {
            await sendRecordingOnHangup(phone, customer, recPath, call.ApiCallId, opts);
        }
        throw e;
    }
}

// ניתוק/שתיקה בתפריט אחרי ההקלטה - שולחים לתמלול ליעד הקבוע של הלקוח (אם יש)
async function sendRecordingOnHangup(phone, customer, recPath, callId, opts) {
    const method = customer ? customer.delivery_method : '';
    const to = method === 'fax' ? (customer.fax || '') : method === 'email' ? (customer.email || '') : '';
    if (!to) {
        console.log('hangup after recording: no delivery target saved - recording not sent');
        return;
    }
    try {
        await axios.post(`${PYTHON_URL}/api/transcribe`, {
            phone,
            rec_url: yemotDownloadUrl(recPath),
            call_id: callId,
            delivery_method: method,
            delivered_to: to,
            transcription_tier: opts.transcriptionTier,
            language: opts.language,
            output_language: opts.outputLanguage
        });
        console.log(`hangup after recording: sent ${recPath} for transcription`);
    } catch (err) {
        console.error('hangup transcribe error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// שלוחה 8 - היסטוריית מסמכים: הלקוח שומע את המסמכים שלו (מהחדש לישן) ויכול
// לקבל כל אחד שוב ליעד הנוכחי שלו. מייל - חינם. פקס - בתשלום, עם אישור.
// כל ההודעות הן קבצים מוקלטים (150-176); מספרים ותאריך עברי - מנוע ההשמעה של ימות.
// השרת: GET /api/customer/<phone>/documents, POST .../documents/resend
// ---------------------------------------------------------------------------
const DOC_TYPE_MSG = { recording: 156, ocr: 157, manuscript: 158 };

function moneyParts(amount) {
    const shekel = Math.floor(amount);
    const agorot = Math.round((amount - shekel) * 100);
    const parts = [];
    if (shekel) parts.push({ type: 'number', data: shekel }, MSG(168));        // 168 - שקל
    if (agorot) parts.push({ type: 'number', data: agorot }, MSG(167));        // 167 - אגורות
    return parts;
}

function documentParts(d, index, total) {
    const parts = [
        MSG(154), { type: 'number', data: index + 1 },   // 154 - מסמך
        MSG(155), { type: 'number', data: total },       // 155 - מתוך
        MSG(DOC_TYPE_MSG[d.type] || 156),                // 156/157/158 - סוג המסמך
    ];
    if (d.date_ddmmyyyy) parts.push(MSG(159), { type: 'dateH', data: d.date_ddmmyyyy });   // 159 - מתאריך
    if (d.hour !== null && d.hour !== undefined) {
        parts.push(MSG(180), { type: 'number', data: d.hour });                              // 180 - בשעה
        if (d.minute) parts.push({ type: 'number', data: d.minute });
    }
    if (d.type === 'recording' && d.minutes) {
        if (d.minutes === 1) parts.push(MSG(176));                                          // 176 - באורך דקה אחת
        else parts.push(MSG(160), { type: 'number', data: d.minutes }, MSG(161));           // 160 - באורך, 161 - דקות
    }
    return parts;
}

async function handleDocuments(call, phone) {
    let data = null;
    try {
        data = (await axios.get(`${PYTHON_URL}/api/customer/${phone}/documents`)).data;
    } catch (e) {
        console.error('documents list error:', e.message);
    }
    if (!data || !data.count) {
        // 153 - לא נמצאו מסמכים קודמים
        await call.id_list_message([MSG(153), { type: 'go_to_folder', data: '/' }]);
        return;
    }

    const docs = data.docs;
    let i = 0;
    let note = null;
    let play = false;
    while (true) {
        const d = docs[i];
        const canPlay = !!d.play_path;   // רק הקלטה מהטלפון (קיימת בימות) - לא קבצי מייל/דרייב/כתב-יד
        const parts = [];
        if (note) parts.push(MSG(note));
        note = null;
        if (play) {
            parts.push({ type: 'file', data: d.play_path });   // ההקלטה עצמה; הקשה עוצרת ומפעילה את הבחירה
            play = false;
        } else {
            parts.push(...documentParts(d, i, docs.length));
        }
        // 181 - (הקלטה) לשמיעת ההקלטה הקישו 4, לקבלת המסמך שוב 1, הבא 2, הקודם 3, חזרה 0
        // 162 - (שאר המסמכים) לקבלת המסמך שוב הקישו 1, הבא 2, הקודם 3, חזרה לתפריט הראשי 0
        parts.push(MSG(canPlay ? 181 : 162));
        const choice = await call.read(parts, 'tap', {
            max_digits: 1, digits_allowed: canPlay ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]
        });

        if (choice === '4' && canPlay) {
            play = true;
            continue;
        }

        if (choice === '2') {
            if (i < docs.length - 1) i++; else note = 174;   // 174 - זה המסמך האחרון
            continue;
        }
        if (choice === '3') {
            if (i > 0) i--; else note = 175;                 // 175 - זה המסמך הראשון
            continue;
        }
        if (choice !== '1') {
            await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
            return;
        }
        note = await resendDocument(call, phone, d);
    }
}

// מחזיר מספר הודעה להשמעה לפני חזרה לתפריט המסמך
async function resendDocument(call, phone, d) {
    const url = `${PYTHON_URL}/api/customer/${phone}/documents/resend`;
    let r;
    try {
        r = (await axios.post(url, { type: d.type, id: d.id })).data;
        if (r.status === 'needs_confirm') {
            const ok = await call.read([
                MSG(165), ...moneyParts(r.cost),   // 165 - שליחה חוזרת לפקס עולה
                MSG(166)                           // 166 - לאישור הקישו 1, לביטול וחזרה הקישו 2
            ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            if (ok !== '1') return 169;           // 169 - השליחה בוטלה
            r = (await axios.post(url, { type: d.type, id: d.id, confirm: 1 })).data;
        }
    } catch (e) {
        if (isHangup(e)) throw e;
        console.error('document resend error:', e.message);
        return 173;                                // 173 - השליחה נכשלה, נסו שוב מאוחר יותר
    }
    switch (r && r.status) {
        case 'sent': return r.via === 'fax' ? 164 : 163;   // 164 - נשלח לפקס, 163 - נשלח למייל
        case 'no_balance': return 170;                      // 170 - אין מספיק יתרה לשליחה בפקס
        case 'no_target': return 171;                       // 171 - לא מוגדר מייל או פקס לשליחה...
        case 'limit': return 172;                           // 172 - הגעתם למספר השליחות החוזרות המרבי להיום
        default: return 173;
    }
}

// ---------------------------------------------------------------------------
// "הקלטה עם עריכה" (ניסיוני - כרגע רק מתפריט המנהל, הקש 3).
// רץ בשלוחת API נפרדת בימות (PHONE_EDIT_FOLDER) שבה מוגדר record_stop_any_key=yes,
// כך שכל מקש עוצר את ההקלטה. מיד אחרי העצירה נפתח "חלון" של 2 שניות להקשה:
//   כוכבית ואז ספרה (למשל *2)  -> מבוצעת הפעולה, וההקלטה ממשיכה מיד (קטע חדש)
//   סולמית (כמו בכל הקלטה)     -> סיום ושליחה לתמלול, מיד
//   כוכבית לבד / פעמיים כוכבית  -> תפריט העריכה (הודעה 179)
// כל קטע נשמר כקובץ נפרד בתיקייה /recordings_edit, והשרת מתמלל קטע-קטע (OpenAI)
// ומכניס את העיצוב בדיוק בגבול בין הקטעים. ניתוק = שליחה של מה שהוקלט עד אז.
// ---------------------------------------------------------------------------
const PHONE_EDIT_FOLDER = '197';   // מספר השלוחה בימות - יש ליצור אותה (ראה הסבר)
const EDIT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*'];

async function handlePhoneEditRecording(call, phone) {
    // ממצא מהשיחה הראשונה (לוג 16.10.2026): המקש שעוצר את ההקלטה *כן* מגיע לשרת -
    // ימות שומרת אותו ומעבירה אותו כמקש הראשון בפעולת ההקשה הבאה. לכן:
    //   1. מיד אחרי ההקלטה קוראים מקש אחד = המקש שעצר את ההקלטה.
    //      סולמית מגיעה כערך ריק (סולמית מסיימת הקשה בימות) -> סיום ושליחה מיד.
    //   2. אם עצרו בכוכבית - קוראים את המקש הבא (חלון של 2 שניות) = מספר הפעולה.
    //      אין מקש -> תפריט העריכה (179).
    //   3. אם עצרו בספרה ישירות - הספרה היא הפעולה.
    const segments = [];
    const st = { bold: false, underline: false, square: false, round: false, quote: false, newPara: false };
    let intro = MSG(178);   // 178 - הסבר קצר על הקלטה עם עריכה + צליל
    let sent = false;
    let recNo = 0;
    const tag = `[edit ${call.ApiCallId}]`;
    const log = (...args) => console.log(tag, ...args);
    log('START phone', phone);

    const literal = (text, noBefore, noAfter) => {
        segments.push({
            type: 'literal', text, bold: st.bold, underline: st.underline,
            new_paragraph: st.newPara, no_space_before: !!noBefore, no_space_after: !!noAfter
        });
        log(`literal "${text}" added (bold=${st.bold} underline=${st.underline})`);
    };
    const send = async (why) => {
        log(`SEND (${why}) segments=${segments.length}:`, JSON.stringify(segments.map(s => ({
            t: s.type, f: s.rec_url ? s.rec_url.split('path=ivr2:')[1] : undefined, x: s.text,
            b: s.bold, u: s.underline, p: s.new_paragraph
        }))));
        if (sent || !segments.some(s => s.type === 'audio')) { log('SEND skipped (already sent or no audio)'); return; }
        sent = true;
        try {
            const r = await axios.post(`${PYTHON_URL}/api/phone-edit`, { phone, call_id: call.ApiCallId, segments });
            log('SEND result', JSON.stringify(r.data));
        } catch (e) {
            log('SEND error', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
        }
    };
    const applyAction = (key) => {
        if (key === '1') st.newPara = true;                       // ירידת שורה
        else if (key === '2') st.bold = !st.bold;                 // הדגשה / סיום הדגשה
        else if (key === '3') st.underline = !st.underline;       // קו תחתון / סיום
        else if (key === '4') { literal(st.square ? ']' : '[', st.square, !st.square); st.square = !st.square; }
        else if (key === '5') { literal(st.round ? ')' : '(', st.round, !st.round); st.round = !st.round; }
        else if (key === '6') literal('-', true, true);           // מקף
        else if (key === '7') literal(':', true, false);          // נקודתיים
        else if (key === '8') literal('?', true, false);          // סימן שאלה
        else if (key === '9') { literal('"', st.quote, !st.quote); st.quote = !st.quote; }  // מירכאות
        log(`ACTION key=${JSON.stringify(key)} -> state ${JSON.stringify(st)}`);
    };

    try {
        while (true) {
            recNo++;
            log(`RECORD #${recNo} start (intro ${intro.data})`);
            const recPath = await call.read([intro], 'record', {
                no_confirm_menu: true, save_on_hangup: true, path: '/recordings_edit', timeout: 3600000
            });
            log(`RECORD #${recNo} returned value=${JSON.stringify(recPath)}`);
            intro = MSG(177);   // 177 - צליל קצר (המשך הקלטה מיידי)
            if (recPath) {
                segments.push({ type: 'audio', rec_url: yemotDownloadUrl(recPath),
                                bold: st.bold, underline: st.underline, new_paragraph: st.newPara });
                st.newPara = false;
            }

            // 1. המקש שעצר את ההקלטה (ימות שומרת אותו לפעולה הבאה)
            const stopKey = await call.read([MSG(177)], 'tap', {
                max_digits: 1, sec_wait: 2, digits_allowed: EDIT_KEYS, allow_empty: true, empty_val: 'NONE'
            });
            log(`STOP key raw=${JSON.stringify(stopKey)}`);
            if (stopKey === 'NONE' || !stopKey) break;   // סולמית (או שתיקה/ניתוק) -> סיום ושליחה

            // 2. עצרו בכוכבית -> המקש הבא הוא הפעולה; אין מקש -> תפריט העריכה
            let actionKey = stopKey;
            if (stopKey === '*') {
                actionKey = await call.read([MSG(177)], 'tap', {
                    max_digits: 1, sec_wait: 2, digits_allowed: EDIT_KEYS, allow_empty: true, empty_val: 'NONE'
                });
                log(`AFTER-STAR key raw=${JSON.stringify(actionKey)}`);
                if (actionKey === 'NONE' || actionKey === '*' || !actionKey) {
                    actionKey = await call.read([MSG(179)], 'tap', {   // 179 - תפריט העריכה
                        max_digits: 1, digits_allowed: EDIT_KEYS.filter(k => k !== '*'),
                        allow_empty: true, empty_val: '0', timeout: 120000
                    });
                    log(`MENU-179 key raw=${JSON.stringify(actionKey)}`);
                }
            }
            applyAction(actionKey);   // '0' - חזרה להקלטה בלי פעולה
        }
    } catch (e) {
        log(`EXCEPTION ${e && e.name}: ${e && e.message}`);
        if (isHangup(e) || isTimeout(e)) await send(isHangup(e) ? 'hangup' : 'timeout');
        throw e;
    }

    await send('finished');
    await call.id_list_message([
        MSG(26),   // 026 - ההקלטה התקבלה, התמלול ישלח אליך בקרוב, שיחה טובה
        { type: 'go_to_folder', data: '/' }
    ]);
}

// רשת ביטחון: שגיאה לא-תפוסה לא תפיל יותר את כל השרת (רק תירשם ללוג).
// זה לא פותר את הבאג המקורי, אבל מונע ממנו להשבית את השירות לכל שאר המתקשרים.
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception (server stays alive):', err.message);
});

// נתיב תיקיית הודעות מערכת בימות
const MSG = (n) => ({ type: 'file', data: `/הודעות מערכת/${String(n).padStart(3,'0')}/000` });

const KEY_MAP = {
    '1': ['.', '1'],
    '2': ['a', 'b', 'c', '2'],
    '3': ['d', 'e', 'f', '3'],
    '4': ['g', 'h', 'i', '4'],
    '5': ['j', 'k', 'l', '5'],
    '6': ['m', 'n', 'o', '6'],
    '7': ['p', 'q', 'r', 's', '7'],
    '8': ['t', 'u', 'v', '8'],
    '9': ['w', 'x', 'y', 'z', '9'],
    '0': ['0'],
};

function decodeEmail(input) {
    let result = '';
    let i = 0;
    while (i < input.length) {
        if (input[i] === '*') { i++; continue; }
        const key = input[i];
        let count = 0;
        while (i < input.length && input[i] === key) { count++; i++; }
        if (KEY_MAP[key]) {
            const chars = KEY_MAP[key];
            result += chars[(count - 1) % chars.length];
        }
    }
    return result;
}

// ישן/לא בשימוש יותר (ראו emailToFileParts למטה) - נשאר כאן רק כתיעוד/גיבוי
// חירום. הבעיה שהובילה להחלפתו: הקראת מייל ע"י הכתבת טקסט מעורב עברית/
// אנגלית למנוע ה-TTS של ימות המשיח יצאה לא מדויקת/לא ברורה בפועל (הגייה
// שגויה של אותיות ומילים באנגלית) - זו הייתה הסיבה המקורית לכל המעבר.
function speakEmail(email) {
    if (!email) return '';

    const letterNames = {
        'a': 'a', 'b': 'b', 'c': 'c', 'd': 'd', 'e': 'e',
        'f': 'f', 'g': 'g', 'h': 'h', 'i': 'i', 'j': 'j',
        'k': 'k', 'l': 'l', 'm': 'm', 'n': 'n', 'o': 'o',
        'p': 'p', 'q': 'q', 'r': 'r', 's': 's', 't': 't',
        'u': 'u', 'v': 'v', 'w': 'w', 'x': 'x', 'y': 'y', 'z': 'z'
    };

    const domainTranslations = {
        'gmail.com': 'גימייל נקודה כום',
        'yahoo.com': 'יאהו נקודה כום',
        'walla.com': 'וואלה נקודה כום',
        'walla.co.il': 'וואלה נקודה קו נקודה איל',
        'hotmail.com': 'הוטמייל נקודה כום',
        'outlook.com': 'אאוטלוק נקודה כום',
        'icloud.com': 'איקלאוד נקודה כום',
        'bezeqint.net': 'בזקאינט נקודה נט',
        'netvision.net.il': 'נטוויזן נקודה נט נקודה איל',
    };

    const atIndex = email.indexOf('@');
    if (atIndex === -1) {
        return email.split('').map(ch => {
            const lower = ch.toLowerCase();
            return letterNames[lower] || ch;
        }).join(' ');
    }

    const localPart = email.substring(0, atIndex);
    const domain = email.substring(atIndex + 1).toLowerCase();

    const spokenLocal = localPart.split('').map(ch => {
        const lower = ch.toLowerCase();
        if (letterNames[lower]) return letterNames[lower];
        return ch;
    }).join(' ');

    const spokenDomain = domainTranslations[domain] ||
        domain.replace(/\./g, ' נקודה ');

    return `${spokenLocal} שטרודל ${spokenDomain}`;
}

// מקריא מייל ע"י הרכבת רצף הקלטות אמיתיות (אות-אחר-אות/ספרה-אחר-ספרה),
// בדיוק כמו שכל שאר המערכת כבר עובדת (MSG() למעלה) - במקום להכתיב טקסט
// מעורב עברית/אנגלית למנוע ה-TTS של ימות המשיח, שיוצא לא מדויק בפועל.
// כל תו הופך לפריט { type: 'file', ... } בודד (MSG עם מספר קבוע - ראו
// טבלת המספור המלאה שנמסרה בנפרד), ו-Yemot מנגן את כל הרשימה ברצף - בדיוק
// כמו שהיא כבר מנגנת היום רשימות של כמה MSG() ברצף בכל מקום אחר בקוד הזה.
//
// טווח המספור (100-146) נבחר בכוונה מעל כל מספרי ה-MSG הקיימים במערכת
// (הגבוה ביותר שבשימוש כרגע הוא 096) - כדי לא להתנגש עם אף הודעת מערכת
// קיימת. 099 נשאר כרווח בטיחות ריק. 097-098 נוצלו עבור הקראת הקוד האישי
// לזיהוי בפקס (ראה handleFaxCode למעלה: 097 = "הקוד האישי שלך הוא",
// 098 = "לשמיעה חוזרת הקש 1, לחזרה הקש 0" - יש להקליט את שתיהן בימות).
// הטבלה המלאה (כולל בדיוק מה להקליט בכל מספר) נמסרה בנפרד.
//   100-125 = אותיות a-z (100=a, 101=b, ... 125=z)
//   126-135 = ספרות 0-9 (126=0, 127=1, ... 135=9)
//   136     = @ (שטרודל)
//   137     = . (נקודה)
//   138-146 = 9 דומיינים נפוצים בשלמותם (ראו KNOWN_DOMAIN_MSG_NUM למטה) -
//             הקלטה ייעודית אחת לכל דומיין, לא איות אות-אחר-אות
const EMAIL_LETTER_MSG_BASE = 100; // a=100 ... z=125
const EMAIL_DIGIT_MSG_BASE = 126;  // 0=126 ... 9=135
const EMAIL_AT_MSG_NUM = 136;
const EMAIL_DOT_MSG_NUM = 137;

function emailToFileParts(value) {
    const parts = [];
    for (const ch of String(value || '')) {
        if (ch === '@') {
            parts.push(MSG(EMAIL_AT_MSG_NUM));
            continue;
        }
        if (ch === '.') {
            parts.push(MSG(EMAIL_DOT_MSG_NUM));
            continue;
        }
        const lower = ch.toLowerCase();
        if (lower >= 'a' && lower <= 'z') {
            parts.push(MSG(EMAIL_LETTER_MSG_BASE + (lower.charCodeAt(0) - 97)));
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            parts.push(MSG(EMAIL_DIGIT_MSG_BASE + (ch.charCodeAt(0) - 48)));
            continue;
        }
        // תו לא מוכר (מקף, קו תחתון וכו') - אין לו הקלטה, מדלגים בשקט במקום
        // לעצור/לזרוק שגיאה על כל הקראת המייל בגלל תו נדיר אחד.
    }
    return parts;
}

// דומיינים נפוצים - כל אחד מקבל הקלטה ייעודית משלו (מישהו אומר בקול את
// שם הדומיין בשלמותו, למשל "ג'ימייל נקודה קום"), במקום לאיית אות-אחר-אות
// **וגם** במקום להכתיב טקסט למנוע ה-TTS של ימות המשיח - לפי בקשת המשתמש
// לא להשתמש ב-TTS בכלל בהקראת מייל, לא רק באיות. ראו טבלת המספור המלאה
// שנמסרה בנפרד (138-146) - כל דומיין כאן הוא MSG() בודד, לא רצף תווים.
const KNOWN_DOMAIN_MSG_NUM = {
    'gmail.com': 138,
    'yahoo.com': 139,
    'walla.com': 140,
    'walla.co.il': 141,
    'hotmail.com': 142,
    'outlook.com': 143,
    'icloud.com': 144,
    'bezeqint.net': 145,
    'netvision.net.il': 146,
};

// מחזירה את החלקים להקראת דומיין בלבד (בלי @) - הקלטה ייעודית אחת לדומיין
// מוכר מהרשימה למעלה, או איות מהקלטות אות-אחר-אות לדומיין אחר. בשני
// המקרים - רק MSG() בקבצי הקלטה, בלי שום { type: 'text' } בכלל.
function domainToParts(domain) {
    const lower = String(domain || '').toLowerCase();
    if (KNOWN_DOMAIN_MSG_NUM[lower]) {
        return [MSG(KNOWN_DOMAIN_MSG_NUM[lower])];
    }
    return emailToFileParts(lower);
}

// מחזירה את החלקים להקראת כתובת מייל **שלמה**: השם שלפני השטרודל מאויית
// מהקלטות אות-אחר-אות, ואז @ (הקלטה), ואז הדומיין - הקלטה ייעודית אחת אם
// הוא מוכר, אחרת איות מהקלטות גם הוא. כל הרכיבים כאן הם MSG() - קבצי
// הקלטה בלבד, אין שום שימוש ב-TTS/{ type: 'text' } בהקראת מייל יותר.
// זו הפונקציה שצריך להשתמש בה לכל הקראה של כתובת מייל **מלאה** (לא רק
// דומיין בפני עצמו - לזה יש domainToParts למעלה).
function fullEmailToParts(email) {
    const value = String(email || '');
    const atIndex = value.indexOf('@');
    if (atIndex === -1) {
        return emailToFileParts(value);
    }
    const localPart = value.substring(0, atIndex);
    const domain = value.substring(atIndex + 1);
    return [
        ...emailToFileParts(localPart),
        MSG(EMAIL_AT_MSG_NUM),
        ...domainToParts(domain),
    ];
}

// ישן/לא בשימוש יותר (ראו digitsToFileParts למטה) - נשאר כאן רק כתיעוד/
// גיבוי חירום.
function speakDigits(value) {
    return String(value || '').split('').join(' ');
}

// מקריאה רצף ספרות (מספר טלפון/פקס) מתוך אותן 10 הקלטות ספרה בודדת
// (126-135) שכבר קיימות ומשמשות לאיות מייל - אין צורך בשום הקלטה נוספת.
// משמשת גם להקראת מספר הטלפון בהסברי שלוחות 5/6 בתפריט הראשי, וגם
// להקראת מספר פקס (עדכון פרטים - גם הקריאה חזרה של הפקס השמור, וגם
// אישור הפקס שהוקלד עכשיו).
function digitsToFileParts(value) {
    const parts = [];
    for (const ch of String(value || '')) {
        if (ch >= '0' && ch <= '9') {
            parts.push(MSG(EMAIL_DIGIT_MSG_BASE + (ch.charCodeAt(0) - 48)));
        }
        // תו שאינו ספרה (מקף וכו') - מדלגים בשקט, כמו בשאר האיות מהקלטות.
    }
    return parts;
}

async function getEmailByKeypad(call) {
    // 045 - להוראות כתיבה הקש 1, להתחיל להקליד הקש 2
    const helpChoice = await call.read([MSG(45)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (helpChoice === '1') {
        // 046 - הוראות הקלדה מלאות לפי מקשי טלפון
        await call.id_list_message([MSG(46)], { prependToNextAction: true });
    }

    // 047 - הקלד את כתובת המייל עד השטרודל, ולסיום הקש סולמית
    const input = await call.read([MSG(47)], 'tap', { max_digits: 100, sec_wait: 7, terminate_keys: ['#'] });

    const localPart = decodeEmail(input);
    return await getDomainAndConfirmEmail(call, localPart, 'כתיבה');
}

async function getEmailByVoice(call, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    // 048 - הקליט את שם המייל שלך עד השטרודל לאחר הצליל, ולסיום הקש סולמית, שים לב ייתכן והזיהוי לא יהיה מדויק
    const recPath = await call.read([MSG(48)], 'record', {
        no_confirm_menu: true,
        save_on_hangup: false,
        path: '/tmp_emails'
    });

    let recUrl = recPath;
    if (recPath && !recPath.startsWith('http')) {
        recUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${recPath}`;
    }

    try {
        const res = await axios.post(`${PYTHON_URL}/api/extract-email-local`, { rec_url: recUrl });
        const localPart = res.data.local_part || '';

        if (!localPart) {
            if (attempt >= MAX_ATTEMPTS) {
                // אחרי כמה נסיונות כושלים - לא משאירים את המתקשר תקוע בלופ, עוברים למצב הקלדה
                await call.id_list_message([MSG(50)], { prependToNextAction: true });
                return await getEmailByKeypad(call);
            }
            // 049 - לא הצלחנו לזהות את שם המייל, נסו שוב
            await call.id_list_message([MSG(49)], { prependToNextAction: true });
            return await getEmailByVoice(call, attempt + 1);
        }

        return await getDomainAndConfirmEmail(call, localPart, 'הקלטה');

    } catch (e) {
        if (isHangup(e)) {
            console.log('getEmailByVoice: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('extract email error:', e.message);
        // 050 - אירעה שגיאה, עוברים למצב כתיבה
        await call.id_list_message([MSG(50)], { prependToNextAction: true });
        return await getEmailByKeypad(call);
    }
}

async function getDomainByVoice(call, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    // 051 - הקליט את סיומת המייל לאחר הצליל ולסיום הקש סולמית, לדוגמה הקליט יאהו נקודה קום
    const recPath = await call.read([MSG(51)], 'record', {
        no_confirm_menu: true,
        save_on_hangup: false,
        path: '/tmp_emails'
    });

    let recUrl = recPath;
    if (recPath && !recPath.startsWith('http')) {
        recUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${recPath}`;
    }

    try {
        const res = await axios.post(`${PYTHON_URL}/api/extract-email-domain`, { rec_url: recUrl });
        const domain = res.data.local_part || '';

        if (!domain) {
            if (attempt >= MAX_ATTEMPTS) {
                // אחרי כמה נסיונות כושלים - עוברים להקלדת הסיומת במקלדת במקום להשאיר תקוע בלופ
                await call.id_list_message([MSG(50)], { prependToNextAction: true });
                // 056 - הקלד את הסיומת ולסיום הקש סולמית
                const domainPart = await call.read([MSG(56)], 'tap', { max_digits: 50, terminate_keys: ['#'] });
                return decodeEmail(domainPart);
            }
            // 052 - לא הצלחנו לזהות את הסיומת, נסו שוב
            await call.id_list_message([MSG(52)], { prependToNextAction: true });
            return await getDomainByVoice(call, attempt + 1);
        }

        // 053 - הסיומת שזוהתה היא [ביטוי טבעי לדומיין מוכר, או איות מהקלטות]
        // + 054 - לאישור הקש 1, לניסיון מחדש הקש 2
        const confirm = await call.read([
            MSG(53),
            ...domainToParts(domain),
            MSG(54)
        ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (confirm === '1') return domain;
        if (attempt >= MAX_ATTEMPTS) {
            await call.id_list_message([MSG(50)], { prependToNextAction: true });
            const domainPart = await call.read([MSG(56)], 'tap', { max_digits: 50, terminate_keys: ['#'] });
            return decodeEmail(domainPart);
        }
        return await getDomainByVoice(call, attempt + 1);

    } catch (e) {
        if (isHangup(e)) {
            console.log('getDomainByVoice: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('extract domain error:', e.message);
        if (attempt >= MAX_ATTEMPTS) {
            await call.id_list_message([MSG(50)], { prependToNextAction: true });
            const domainPart = await call.read([MSG(56)], 'tap', { max_digits: 50, terminate_keys: ['#'] });
            return decodeEmail(domainPart);
        }
        return await getDomainByVoice(call, attempt + 1);
    }
}

async function getDomainAndConfirmEmail(call, localPart, mode) {
    // 055 - לסיומת ג'ימייל הקש 1... לסיומת אחרת הקש 5
    const domainChoice = await call.read([MSG(55)], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3, 4, 5] });

    const domains = { '1': 'gmail.com', '2': 'yahoo.com', '3': 'walla.com', '4': 'hotmail.com' };

    let domain = '';
    if (domainChoice === '5') {
        if (mode === 'הקלטה') {
            domain = await getDomainByVoice(call);
        } else {
            // 056 - הקלד את הסיומת ולסיום הקש סולמית
            const domainPart = await call.read([MSG(56)], 'tap', { max_digits: 50, terminate_keys: ['#'] });
            domain = decodeEmail(domainPart);
        }
    } else {
        domain = domains[domainChoice];
    }

    const email = `${localPart}@${domain}`;

    const confirm = await call.read([
        MSG(66), // המייל שהתקבל הוא
        ...fullEmailToParts(email),
        MSG(67), // לאישור הקש 1, לתיקון הקש 2
    ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (confirm === '1') return email;
    if (mode === 'הקלטה') return await getEmailByVoice(call);
    return await getEmailByKeypad(call);
}

async function getEmail(call) {
    // 057 - למצב הקלטה הקש 1, למצב כתיבה הקש 2
    const modeChoice = await call.read([MSG(57)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (modeChoice === '1') {
        return await getEmailByVoice(call);
    } else {
        return await getEmailByKeypad(call);
    }
}

router.get('/', async (call) => {
    await presentMainMenu(call, call.ApiPhone);
});

// שלוחת "הקלטה עם עריכה" בימות (PHONE_EDIT_FOLDER) - api_link שלה מצביע לכאן
router.get('/phone-edit', async (call) => {
    const ADMIN_PHONE = '0527134491';
    if (call.ApiPhone !== ADMIN_PHONE) {   // בינתיים רק המנהל
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
        return;
    }
    await handlePhoneEditRecording(call, call.ApiPhone);
});

// תפריט ראשי - מופרד מ-router.get('/') כדי שאפשר יהיה להגיע אליו גם משלוחה 7
// (זיהוי תלמיד לפי מספר תלמיד), עם הטלפון האמיתי שהתלמיד רשום תחתיו ב-DB
// ולא הטלפון שממנו הוא בפועל מתקשר.
async function presentMainMenu(call, phone) {
    let customer = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
        if (customer.is_blocked) {
            const blockedChoice = await call.read([
                // 005 - מצטערים, חשבונך חסום, לפרטים פנה לשירות לקוחות
                MSG(5),
                // 010 - השאר הודעתך למנהל לאחר הצליל, לסיום הקש סולמית
                // (לפני כן: הקש 9 להשארת הודעה למנהל - כבר חלק מ-MSG(5) אם רוצים, נוסיף הנחיה)
            ], 'tap', { max_digits: 1, digits_allowed: [9], sec_wait: 5 });

            if (blockedChoice === '9') {
                await handleManagerMessage(call, phone, customer);
                return;
            }

            await call.id_list_message([{ type: 'go_to_folder', data: 'hangup' }]);
            return;
        }
    } catch (e) {
        if (isHangup(e)) {
            console.log('router /: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('customer error:', e.message);
    }

    const balance = customer ? parseFloat(customer.balance || 0) : 0;
    const balanceShekel = Math.floor(balance);
    const balanceAgorot = Math.round((balance - balanceShekel) * 100);

    // בניית הקראת יתרה דינמית
    const balanceParts = [];
    if (balance > 0) {
        // 003 - יתרתך היא
        balanceParts.push(MSG(3));
        if (balanceAgorot > 0) {
            balanceParts.push({ type: 'text', data: `${balanceShekel} שקל ו ${balanceAgorot} אגורות` });
        } else {
            balanceParts.push({ type: 'text', data: `${balanceShekel} שקל` });
        }
    } else {
        // 093 - אין לך עדיין יתרה בארנק. לטעינת ארנק הקש 2 ואז 1
        balanceParts.push(MSG(93));
    }

    // בדוק הקלטות ממתינות לתשלום
    let pendingParts = [];
    try {
        const pendingRes = await axios.get(`${PYTHON_URL}/api/customer/pending-recordings?phone=${phone}`);
        const pending = pendingRes.data;
        if (pending.has_pending) {
            if (pending.enough_balance) {
                // יש יתרה עכשיו - הפעל תמלול אוטומטית
                await axios.post(`${PYTHON_URL}/api/process-pending`, { phone });
                pendingParts = [
                    MSG(77),  // נמצאה הקלטה ממתינה באורך
                    { type: 'text', data: String(pending.minutes) },
                    MSG(81),  // דקות, יש לך עכשיו יתרה מספיקה, התמלול יתחיל עכשיו וישלח אליך בקרוב
                ];
            } else {
                // עדיין אין יתרה מספיקה
                const costShekel = Math.floor(pending.cost);
                const costAgorot = Math.round((pending.cost - costShekel) * 100);
                const costStr = costAgorot > 0
                    ? `${costShekel} שקל ו ${costAgorot} אגורות`
                    : `${costShekel} שקל`;

                const balShekel = Math.floor(pending.balance);
                const balAgorot = Math.round((pending.balance - balShekel) * 100);
                const balStr = balAgorot > 0
                    ? `${balShekel} שקל ו ${balAgorot} אגורות`
                    : `${balShekel} שקל`;

                pendingParts = [
                    MSG(77),  // נמצאה הקלטה ממתינה באורך
                    { type: 'text', data: String(pending.minutes) },
                    MSG(78),  // דקות, העלות היא
                    { type: 'text', data: costStr },
                    MSG(79),  // יתרתך היא
                    { type: 'text', data: balStr },
                    MSG(80),  // אנא טען ארנק כדי שהתמלול יבוצע
                ];
            }
        }
    } catch (e) {
        console.error('pending check error:', e.message);
    }

    const ADMIN_PHONE = '0527134491';
    // 7 — כניסה לפי מספר תלמיד (ראה handleStudentLogin), פתוח לכל מתקשר
    // 8 — היסטוריית מסמכים ושליחה חוזרת (ראה handleDocuments). יש לעדכן גם את הקלטת התפריט הראשי (004)
    const allowedDigits = phone === ADMIN_PHONE ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4, 5, 6, 7, 8, 9];

    const choice = await call.read([
        ...pendingParts,  // הודעת הקלטה ממתינה לתשלום — נשמעת ראשונה, לפני הברכה
        MSG(1),   // 001 - שלום, ברוכים הבאים למערכת התמלול
        MSG(2),   // 002 - קובץ ריק — הודעה זמנית לכניסה
        ...balanceParts,
        MSG(4),   // 004 - תפריט ראשי: הקש 1... הקש 9 (יש לעדכן בימות שגם הקש 7 קיים - כניסה עם מספר תלמיד)
    ], 'tap', { max_digits: 1, digits_allowed: allowedDigits });

    if (choice === '1') {
        await handleRecording(call, phone, customer);
    } else if (choice === '4') {
        await handleQuickRecord(call, phone, customer);
    } else if (choice === '3') {
        await handleExplainMenu(call, phone, customer);
    } else if (choice === '5') {
        await handleEmailInstructions(call, phone, customer);
    } else if (choice === '6') {
        await handleHandwritingInstructions(call, phone, customer);
    } else if (choice === '7') {
        await handleStudentLogin(call);
    } else if (choice === '8') {
        await handleDocuments(call, phone);
    } else if (choice === '9') {
        await handleManagerMessage(call, phone, customer);
    } else if (choice === '0' && phone === ADMIN_PHONE) {
        await handleAdminMenu(call);
    } else {
        await handleOptions(call, phone);
    }
}

async function handleStudentLogin(call, attempt = 1) {
    const MAX_ATTEMPTS = 3;

    // 095 - הקש את מספר התלמיד שלך ולאחר מכן הקש סולמית (הודעה חדשה - יש להקליט בימות)
    const code = await call.read([MSG(95)], 'tap', { max_digits: 10, terminate_keys: ['#'] });

    if (!code) {
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
        return;
    }

    let resolvedPhone = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/by-student/${code}`);
        resolvedPhone = res.data.phone;
    } catch (e) {
        if (isHangup(e)) {
            console.log('handleStudentLogin: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('by-student lookup error:', e.response ? e.response.data : e.message);
    }

    if (!resolvedPhone) {
        if (attempt >= MAX_ATTEMPTS) {
            // 096 - מספר תלמיד לא נמצא, או שהשימוש אינו מותר כרגע (מחוץ לשעות שהמוסד הגדיר).
            // אחרי כמה נסיונות כושלים - לא משאירים את המתקשר תקוע בלופ, חוזרים לתפריט הראשי.
            await call.id_list_message([MSG(96), { type: 'go_to_folder', data: '/' }]);
            return;
        }
        // 096 - מספר תלמיד לא נמצא, או שהשימוש אינו מותר כרגע. נסה שוב
        await call.id_list_message([MSG(96)], { prependToNextAction: true });
        return await handleStudentLogin(call, attempt + 1);
    }

    // זוהה בהצלחה - ממשיכים בדיוק כמו כל לקוח אחר (יתרה, הקלטה, אפשרויות וכו'),
    // רק עם הטלפון האמיתי של התלמיד ולא הטלפון שממנו הוא בפועל מתקשר.
    await presentMainMenu(call, resolvedPhone);
}

async function handleEmailInstructions(call, phone, customer) {
    const hasEmail = !!(customer && customer.email);

    // כל לקוח שומע את ההסבר המלא, עם מייל או בלי
    const choice = await call.read([
        // 041 - הסבר שלוחה 5 עד לפני מספר הטלפון
        MSG(41),
        ...digitsToFileParts(phone),
        // 042 - המשך הסבר שלוחה 5 + הקש 1 לקבלת הוראות, הקש 0 לחזרה
        MSG(42),
    ], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

    if (choice === '1') {
        if (hasEmail) {
            try {
                await axios.post(`${PYTHON_URL}/api/send-email-instructions`, { phone });
                await call.id_list_message([
                    // 038 - ההוראות המפורטות נשלחו לכתובת המייל שלך, שיחה טובה
                    MSG(38),
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                if (isHangup(e)) {
                    console.log('handleEmailInstructions: call hangup, aborting flow');
                    throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
                }
                console.error('send-email-instructions error:', e.message);
                await call.id_list_message([
                    // 039 - אירעה שגיאה בשליחת ההוראות, שיחה טובה
                    MSG(39),
                    { type: 'go_to_folder', data: '/' }
                ]);
            }
        } else {
            await call.id_list_message([
                // 040 - כדי לקבל הוראות מפורטות במייל יש לעדכן קודם כתובת מייל...
                MSG(40),
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
}

async function handleHandwritingInstructions(call, phone, customer) {
    const hasEmail = !!(customer && customer.email);

    // כל לקוח שומע את ההסבר המלא, עם מייל או בלי. הקש 2 (חדש) - שמיעת הקוד
    // האישי לזיהוי בפקס, ראה handleFaxCode למטה. יש לעדכן את הקלטה 044
    // הקיימת בימות כך שתזכיר גם את הקש 2 (בנוסף להקש 1 הקיים) - התוכן
    // הטקסטואלי המדויק שיש להקליט נמסר בנפרד למשתמש.
    const choice = await call.read([
        // 043 - הסבר שלוחה 6 עד לפני מספר הטלפון
        MSG(43),
        ...digitsToFileParts(phone),
        // 044 - המשך הסבר שלוחה 6 + הקש 1 לקבלת הוראות במייל, הקש 2 לשמיעת
        // הקוד האישי לזיהוי בפקס, הקש 0 לחזרה (יש לעדכן את ההקלטה בימות!)
        MSG(44),
    ], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2] });

    if (choice === '1') {
        if (hasEmail) {
            try {
                await axios.post(`${PYTHON_URL}/api/send-handwriting-instructions`, { phone });
                await call.id_list_message([
                    // 038 - ההוראות המפורטות נשלחו לכתובת המייל שלך, שיחה טובה
                    MSG(38),
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                if (isHangup(e)) {
                    console.log('handleHandwritingInstructions: call hangup, aborting flow');
                    throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
                }
                console.error('send-handwriting-instructions error:', e.message);
                await call.id_list_message([
                    // 039 - אירעה שגיאה בשליחת ההוראות, שיחה טובה
                    MSG(39),
                    { type: 'go_to_folder', data: '/' }
                ]);
            }
        } else {
            await call.id_list_message([
                // 040 - כדי לקבל הוראות מפורטות במייל יש לעדכן קודם כתובת מייל...
                MSG(40),
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    if (choice === '2') {
        await handleFaxCode(call, phone);
        return;
    }

    await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
}

// הקראת הקוד האישי (5 ספרות) לזיהוי בשליחת פקס - בכוונה **רק** בטלפון,
// לעולם לא נשלח במייל (ראה routes/dictate.py._send_manuscript_email
// בפרויקט הפייתון - הוסר משם בכוונה). כל לקוח יכול לשמוע את הקוד שלו כמה
// פעמים שירצה, בכל שיחה - נוצר עצלנית בצד הפייתון בפעם הראשונה שמבקשים
// אותו (routes/api.py get_customer_fax_code).
async function handleFaxCode(call, phone) {
    let faxCode = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}/fax-code`);
        faxCode = res.data.fax_code;
    } catch (e) {
        if (isHangup(e)) {
            console.log('handleFaxCode: call hangup, aborting flow');
            throw e;
        }
        console.error('fax-code lookup error:', e.message);
    }

    if (!faxCode) {
        await call.id_list_message([
            // 039 - אירעה שגיאה (משותפת עם send-handwriting-instructions למעלה)
            MSG(39),
            { type: 'go_to_folder', data: '/' }
        ]);
        return;
    }

    // 097 - הקוד האישי שלך הוא (הודעה חדשה - יש להקליט בימות)
    // 098 - לשמיעה חוזרת הקש 1, לחזרה לתפריט הראשי הקש 0 (הודעה חדשה - יש להקליט בימות)
    const again = await call.read([
        MSG(97),
        ...digitsToFileParts(faxCode),
        MSG(98),
    ], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

    if (again === '1') {
        return await handleFaxCode(call, phone);
    }

    await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
}

async function handleManagerMessage(call, phone, customer) {
    // משריינים מראש ID קצר ורציף (כמו שהיה במקור) - כדי שהמספר שמופיע בשלוחת
    // ההאזנה בימות יתאים בדיוק למספר שמוצג לכל הודעה בממשק הניהול. ה"הגנה"
    // מפני הודעות ריקות לא נעשית יותר ע"י מניעת שריון (זה שבר את המספור),
    // אלא ע"י סינון בתצוגת הממשק: הודעות בלי rec_url (כלומר לא הוקלט בפועל
    // עד הסוף) פשוט לא מוצגות ברשימה, גם אם קיימת להן רשומה שקטה ב-DB.
    let msgId = call.ApiCallId;
    try {
        const idRes = await axios.post(`${PYTHON_URL}/api/manager-message-reserve`, {
            phone,
            call_id: call.ApiCallId
        });
        msgId = idRes.data.id;
    } catch (e) {
        console.error('reserve error:', e.message);
    }

    // 009 - קובץ ריק — הודעה זמנית לפני הודעה למנהל
    // 010 - השאר הודעתך למנהל לאחר הצליל, לסיום הקש סולמית
    let recPath;
    try {
        recPath = await call.read([MSG(9), MSG(10)], 'record', {
            no_confirm_menu: true,
            save_on_hangup: false,
            path: '/manager_messages',
            file_name: String(msgId)
        });
    } catch (e) {
        if (isHangup(e)) {
            console.log('handleManagerMessage: hangup before recording finished, not saving');
            throw e; // מעבירים הלאה - שהספרייה תטפל בניתוק כרגיל
        }
        throw e;
    }

    if (!recPath) {
        // הקיש סולמית מיד בלי להקליט כלום - גם כאן לא שומרים תוכן, הרשומה
        // המשוריינת תישאר בלי rec_url ולכן לא תוצג בממשק (ראו admin.py)
        console.log('handleManagerMessage: empty recording, not saving');
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
        return;
    }

    console.log('manager recPath:', recPath);

    let fullRecUrl = recPath;
    if (recPath && !recPath.startsWith('http')) {
        const cleanPath = recPath.startsWith('/') ? recPath : `/${recPath}`;
        fullRecUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${cleanPath}`;
    }

    console.log('manager fullRecUrl:', fullRecUrl);

    try {
        await axios.post(`${PYTHON_URL}/api/manager-message`, {
            phone,
            rec_url: fullRecUrl,
            rec_path: recPath,
            call_id: call.ApiCallId,
            email: customer ? (customer.email || '') : '',
            fax: customer ? (customer.fax || '') : '',
            delivery_method: customer ? (customer.delivery_method || '') : '',
            name: customer ? (customer.name || '') : ''
        });
    } catch (e) {
        console.error('manager message error:', e.message);
    }

    await call.id_list_message([
        // 011 - הודעתך התקבלה, המנהל יחזור אליך בהקדם, שיחה טובה
        MSG(11),
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleRecording(call, phone, customer) {
    const balance = customer ? parseFloat(customer.balance || 0) : 0;

    let priceBasic = 0.90;
    let pricePremium = 1.90;
    try {
        const settingsRes = await axios.get(`${PYTHON_URL}/api/settings`);
        priceBasic = parseFloat(settingsRes.data.price_per_20min_basic || 0.90);
        pricePremium = parseFloat(settingsRes.data.price_per_20min_premium || 1.90);
    } catch (e) {
        console.error('could not fetch settings:', e.message);
    }

    const minPrice = Math.min(priceBasic, pricePremium);

    if (balance < minPrice) {
        if (balance <= 0) {
            await call.id_list_message([
                // 012 - מצטערים, אין יתרה בארנק שלך, לטעינת ארנק חזור לתפריט הראשי והקש 2, שיחה טובה
                MSG(12),
                { type: 'go_to_folder', data: '/' }
            ]);
        } else {
            const balanceShekel = Math.floor(balance);
            const balanceAgorot = Math.round((balance - balanceShekel) * 100);
            const balanceStr = balanceAgorot > 0
                ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
                : `${balanceShekel} שקל`;
            await call.id_list_message([
                // 013 - מצטערים, יתרתך [דינמי] 014 - אינה מספיקה לתמלול, לטעינת ארנק חזור לתפריט הראשי והקש 2, שיחה טובה
                MSG(13),
                { type: 'text', data: balanceStr },
                MSG(14),
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    if (balance < 10) {
        const balanceShekel = Math.floor(balance);
        const balanceAgorot = Math.round((balance - balanceShekel) * 100);
        const balanceStr = balanceAgorot > 0
            ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
            : `${balanceShekel} שקל`;

        const choice = await call.read([
            MSG(61), // שים לב, יתרתך נמוכה
            { type: 'text', data: balanceStr },
            MSG(62), // בלבד, להמשך הקלטה הֵקֵש 1, לחזרה לתפריט הֵקֵש 0
        ], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '0') {
            await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
            return;
        }
    }

    // 015 - לתמלול רגיל הקש 1 לתמלול מקצועי הקש 2, 083 - הכרזת מחיר, ואז הלקוח בוחר
    const tierChoice = await call.read([MSG(15), MSG(83)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    const transcriptionTier = tierChoice === '2' ? 'premium' : 'gemini';

    const requiredPrice = transcriptionTier === 'premium' ? pricePremium : priceBasic;

    if (balance < requiredPrice) {
        const balanceShekel = Math.floor(balance);
        const balanceAgorot = Math.round((balance - balanceShekel) * 100);
        const balanceStr = balanceAgorot > 0
            ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
            : `${balanceShekel} שקל`;

        const priceShekel = Math.floor(requiredPrice);
        const priceAgorot = Math.round((requiredPrice - priceShekel) * 100);
        const priceStr = priceAgorot > 0
            ? `${priceShekel} שקל ו ${priceAgorot} אגורות`
            : `${priceShekel} שקל`;

        await call.id_list_message([
            MSG(16),
            { type: 'text', data: balanceStr },
            MSG(17),
            transcriptionTier === 'premium' ? MSG(59) : MSG(58),
            MSG(18),
            { type: 'text', data: priceStr },
            { type: 'go_to_folder', data: '/' }
        ]);
        return;
    }

    let language = 'he';
    let outputLanguage = 'he';

    if (transcriptionTier === 'premium') {
        // אלף בוט — שואל רק על שפת פלט (הוא מזהה שפת הקלטה אוטומטית)
        // 090 - לקבל את התמלול בעברית הקש 1, בשפת ההקלטה הקש 2
        const outChoice = await call.read([MSG(90)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        outputLanguage = outChoice === '1' ? 'he' : 'original';
    } else {
        // גמיני — שואל על שפת הקלטה ושפת פלט
        // 020 - לתמלול בעברית הקש 1, ביידיש הקש 2, באנגלית הקש 3
        const langChoice = await call.read([MSG(20)], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });
        language = langChoice === '2' ? 'yi' : langChoice === '3' ? 'en' : 'he';

        if (language === 'yi') {
            // 021 - לקבל את התמלול ביידיש הקש 1, בעברית הקש 2
            const outChoice = await call.read([MSG(21)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            outputLanguage = outChoice === '2' ? 'he' : 'yi';
        } else if (language === 'en') {
            // 022 - לקבל את התמלול באנגלית הקש 1, בעברית הקש 2
            const outChoice = await call.read([MSG(22)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            outputLanguage = outChoice === '2' ? 'he' : 'en';
        }
    }

    // 023 - השאר את הודעתך לאחר הצליל, לסיום הקש סולמית או נתק
    // הקלטה עם תפריט אחרי סולמית: 1 שליחה, 2 הקלטה מחדש, 3 המשך הקלטה (ראה recordWithMenu)
    const recPath = await recordWithMenu(call, phone, customer, { transcriptionTier, language, outputLanguage });

    console.log('recPath received:', recPath);

    let fullRecUrl = recPath;
    if (recPath && !recPath.startsWith('http')) {
        fullRecUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${recPath}`;
    }

    let deliveryMethod = customer ? customer.delivery_method : '';
    let deliveredTo = '';

    if (deliveryMethod === 'fax') {
        deliveredTo = customer ? (customer.fax || '') : '';
    } else if (deliveryMethod === 'email') {
        deliveredTo = customer ? (customer.email || '') : '';
    }

    if (!deliveredTo) {
        // 024 - לשליחה למייל הקש 1, לשליחה לפקס הקש 2
        const deliveryChoice = await call.read([MSG(24)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (deliveryChoice === '1') {
            const email = await getEmail(call);
            deliveryMethod = 'email';
            deliveredTo = email;
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' });
            } catch (e) {}
        } else {
            // 025 - הקש את מספר הפקס שלך, ולאחר מכן הקש סולמית
            const fax = await call.read([MSG(25)], 'tap', { max_digits: 15, terminate_keys: ['#'] });
            deliveryMethod = 'fax';
            deliveredTo = fax;
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax, delivery_method: 'fax' });
            } catch (e) {}
        }
    }

    try {
        await axios.post(`${PYTHON_URL}/api/transcribe`, {
            phone,
            rec_url: fullRecUrl,
            call_id: call.ApiCallId,
            delivery_method: deliveryMethod,
            delivered_to: deliveredTo,
            transcription_tier: transcriptionTier,
            language: language,
            output_language: outputLanguage
        });
    } catch (e) {
        console.error('transcribe error:', e.message);
    }

    await call.id_list_message([
        // 026 - ההקלטה התקבלה, התמלול ישלח אליך בקרוב, שיחה טובה
        MSG(26),
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleOptions(call, phone) {
    // 027 - לטעינת ארנק הקש 1, לעדכון פרטים הקש 2, לשמיעת מחירון הקש 3, לחזרה הקש 0
    const choice = await call.read([MSG(27)], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3] });

    if (choice === '1') {
        await handleTopUp(call, phone);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else if (choice === '3') {
        await handlePriceList(call, phone);
    } else {
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
    }
}

async function handlePriceList(call, phone) {
    // 092 - מחירון קצר, לחזרה לתפריט הראשי הקש 0
    await call.read([
        MSG(92)
    ], 'tap', { max_digits: 1, digits_allowed: [0] });

    await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
}

async function handleTopUp(call, phone) {
    await call.id_list_message([
        MSG(82),  // 082 - קובץ ריק — הכרזת מבצע זמנית (להחליף לפי צורך)
        MSG(7),   // 007 - קובץ ריק — הודעה זמנית לפני סליקה
        MSG(8),   // 008 - תכף תתבקש להכניס את פרטי כרטיס האשראי שלך
        { type: 'go_to_folder', data: '199' }
    ]);
}

async function handleUpdateDetails(call, phone) {
    let customer = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
    } catch (e) {}

    const emailParts = (customer && customer.email)
        ? [MSG(68), ...fullEmailToParts(customer.email)] // המייל שלך הוא [דומיין מוכר: ביטוי טבעי / איות מהקלטות]
        : [MSG(74)]; // לא מעודכן מייל
    const faxParts = (customer && customer.fax)
        ? [MSG(69), ...digitsToFileParts(customer.fax)] // הפקס שלך הוא [רצף הקלטות ספרה-ספרה]
        : [MSG(75)]; // לא מעודכן פקס
    const deliveryParts = [
        MSG(70), // שיטת השליחה היא
        (customer && customer.delivery_method === 'fax') ? MSG(72) : MSG(71), // פקס / מייל
    ];

    const choice = await call.read([
        ...emailParts,
        ...faxParts,
        ...deliveryParts,
        MSG(73), // לעדכון מייל הקש 1, לעדכון פקס הקש 2, לשינוי שיטת שליחה הקש 3, לחזרה הקש 0 לעדכון ברירת מחדל הקש 4
    ], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3, 4] });

    if (choice === '1') {
        const email = await getEmail(call);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' });
        } catch (e) {}
        // 028 - המייל עודכן בהצלחה
        await call.id_list_message([MSG(28)], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '2') {
        // 029 - הקש את מספר הפקס שלך ולאחר מכן הקש סולמית
        const fax = await call.read([MSG(29)], 'tap', { max_digits: 15, terminate_keys: ['#'] });
        const confirm = await call.read([
            MSG(76), // מספר הפקס שהוקלד הוא
            ...digitsToFileParts(fax),
            MSG(67), // לאישור הקש 1, לתיקון הקש 2
        ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        if (confirm === '2') return await handleUpdateDetails(call, phone);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax, delivery_method: 'fax' });
        } catch (e) {}
        // 030 - הפקס עודכן בהצלחה
        await call.id_list_message([MSG(30)], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '3') {
        // 031 - לשליחה למייל הקש 1, לשליחה לפקס הקש 2
        const methodChoice = await call.read([MSG(31)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (methodChoice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'email' });
            } catch (e) {}
            // 032 - שיטת השליחה עודכנה למייל
            await call.id_list_message([MSG(32)], { prependToNextAction: true });
        } else {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'fax' });
            } catch (e) {}
            // 033 - שיטת השליחה עודכנה לפקס
            await call.id_list_message([MSG(33)], { prependToNextAction: true });
        }
        return await handleUpdateDetails(call, phone);

    } else if (choice === '4') {
        await handleDefaultSettings(call, phone, customer);
        return await handleUpdateDetails(call, phone);
    } else {
        await handleOptions(call, phone);
    }
}

async function handleDefaultSettings(call, phone, customer) {
    // טען נתונים עדכניים מהשרת
    let currentDefaults = {};
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        const ds = res.data.default_settings;
        // תמיכה ב-JSON string וב-object
        if (typeof ds === 'string') {
            currentDefaults = JSON.parse(ds);
        } else if (ds && typeof ds === 'object') {
            currentDefaults = ds;
        } else {
            currentDefaults = {};
        }
        customer = res.data;
    } catch (e) {
        console.error('load defaults error:', e.message);
        currentDefaults = {};
    }

    const isPremium = currentDefaults.tier === 'premium';
    const tierName = isPremium ? 'תמלול מקצועי' : 'תמלול רגיל';
    const outLangName = currentDefaults.output_language === 'original' ? 'שפת ההקלטה'
        : currentDefaults.output_language === 'yi' ? 'יידיש'
        : currentDefaults.output_language === 'en' ? 'אנגלית' : 'עברית';

    let summaryText, allowedChoices;

    if (isPremium) {
        // תמלול מקצועי — רק סוג תמלול + שפת פלט
        summaryText = `${tierName}, שפת פלט ${outLangName}`;
        allowedChoices = [0, 1, 3]; // אין אפשרות 2 (שפת הקלטה)
    } else {
        const langName = currentDefaults.language === 'yi' ? 'יידיש' : currentDefaults.language === 'en' ? 'אנגלית' : 'עברית';
        summaryText = `${tierName}, שפת הקלטה ${langName}, שפת פלט ${outLangName}`;
        allowedChoices = [0, 1, 2, 3];
    }

    const choice = await call.read([
        MSG(85), // ברירת המחדל הנוכחית שלך היא
        { type: 'text', data: summaryText },
        isPremium ? MSG(91) : MSG(86),
        // 091 - לשינוי סוג תמלול הקש 1, לשינוי שפת פלט הקש 3, לחזרה הקש 0
        // 086 - לשינוי סוג תמלול הקש 1, לשינוי שפת הקלטה הקש 2, לשינוי שפת פלט הקש 3, לחזרה הקש 0
    ], 'tap', { max_digits: 1, digits_allowed: allowedChoices });

    if (choice === '0') return;

    let newDefaults = { ...currentDefaults };

    if (choice === '1') {
        // שינוי סוג תמלול
        const t = await call.read([MSG(15)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        newDefaults.tier = t === '2' ? 'premium' : 'gemini';
        // איפוס שפת פלט בהתאם לסוג החדש
        if (newDefaults.tier === 'premium') {
            newDefaults.output_language = 'he';
        }
    } else if (choice === '2' && !isPremium) {
        // שינוי שפת הקלטה — רק לגמיני
        const l = await call.read([MSG(20)], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });
        newDefaults.language = l === '2' ? 'yi' : l === '3' ? 'en' : 'he';
        newDefaults.output_language = newDefaults.language;
    } else if (choice === '3') {
        if (isPremium) {
            // אלף בוט — עברית או שפת ההקלטה
            // 090 - לקבל את התמלול בעברית הקש 1, בשפת ההקלטה הקש 2
            const o = await call.read([MSG(90)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            newDefaults.output_language = o === '1' ? 'he' : 'original';
        } else {
            // גמיני — לפי שפת ההקלטה
            const lang = currentDefaults.language || 'he';
            if (lang === 'yi') {
                const o = await call.read([MSG(21)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
                newDefaults.output_language = o === '1' ? 'yi' : 'he';
            } else if (lang === 'en') {
                const o = await call.read([MSG(22)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
                newDefaults.output_language = o === '1' ? 'en' : 'he';
            } else {
                newDefaults.output_language = 'he';
            }
        }
    }

    try {
        await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, default_settings: newDefaults });
        await call.id_list_message([MSG(87)], { prependToNextAction: true }); // ברירת המחדל עודכנה
    } catch (e) {
        if (isHangup(e)) {
            console.log('handleDefaultSettings: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('update default settings error:', e.message);
    }

    // חזור לתפריט ברירת מחדל (לא לעדכון פרטים)
    return await handleDefaultSettings(call, phone, customer);
}

async function handleExplainMenu(call, phone, customer) {
    // 006 - הסבר מערכת, 088 - תנאי שימוש
    const choice = await call.read([
        MSG(88), // להסבר על המערכת הקש 1, לתנאי שימוש הקש 2
    ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (choice === '1') {
        await call.id_list_message([
            MSG(6),   // 006 - הסבר על המערכת
            { type: 'go_to_folder', data: '/' }
        ]);
    } else {
        await call.id_list_message([
            MSG(89), // 089 - תנאי שימוש
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleQuickRecord(call, phone, customer) {
    const balance = customer ? parseFloat(customer.balance || 0) : 0;

    let priceBasic = 0.90;
    try {
        const settingsRes = await axios.get(`${PYTHON_URL}/api/settings`);
        priceBasic = parseFloat(settingsRes.data.price_per_20min_basic || 0.90);
    } catch (e) {}

    // טען ברירות מחדל של הלקוח (גם אם אין כסף — עדיין מקליטים ושומרים)
    const defaults = customer && customer.default_settings ? customer.default_settings : {};
    const transcriptionTier = defaults.tier || 'gemini';
    const language = defaults.language || 'he';
    const outputLanguage = defaults.output_language || 'he';

    // הקלטה מיידית
    // הקלטה עם תפריט אחרי סולמית: 1 שליחה, 2 הקלטה מחדש, 3 המשך הקלטה (ראה recordWithMenu)
    const recPath = await recordWithMenu(call, phone, customer, { transcriptionTier, language, outputLanguage });

    let fullRecUrl = recPath;
    if (recPath && !recPath.startsWith('http')) {
        fullRecUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${recPath}`;
    }

    let deliveryMethod = customer ? customer.delivery_method : '';
    let deliveredTo = '';

    if (deliveryMethod === 'fax') {
        deliveredTo = customer ? (customer.fax || '') : '';
    } else if (deliveryMethod === 'email') {
        deliveredTo = customer ? (customer.email || '') : '';
    }

    if (!deliveredTo) {
        const deliveryChoice = await call.read([MSG(24)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        if (deliveryChoice === '1') {
            const email = await getEmail(call);
            deliveryMethod = 'email';
            deliveredTo = email;
            try { await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' }); } catch (e) {}
        } else {
            const fax = await call.read([MSG(25)], 'tap', { max_digits: 15, terminate_keys: ['#'] });
            deliveryMethod = 'fax';
            deliveredTo = fax;
            try { await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax, delivery_method: 'fax' }); } catch (e) {}
        }
    }

    try {
        await axios.post(`${PYTHON_URL}/api/transcribe`, {
            phone, rec_url: fullRecUrl, call_id: call.ApiCallId,
            delivery_method: deliveryMethod, delivered_to: deliveredTo,
            transcription_tier: transcriptionTier, language, output_language: outputLanguage
        });
    } catch (e) {
        console.error('quick record transcribe error:', e.message);
    }

    await call.id_list_message([MSG(26), { type: 'go_to_folder', data: '/' }]);
}

async function handleAdminMenu(call) {
    // 094 - לשמיעת הודעות הקש 1, למעבר לשלוחה 59 הקש 2, להקלטה עם עריכה הקש 3 (יש להקליט מחדש)
    const choice = await call.read([MSG(94)], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });

    if (choice === '2') {
        await call.id_list_message([{ type: 'go_to_folder', data: '59' }]);
        return;
    }
    if (choice === '3') {
        await call.id_list_message([{ type: 'go_to_folder', data: PHONE_EDIT_FOLDER }]);
        return;
    }

    await handleAdminMessages(call);
}

async function handleAdminMessages(call) {
    // 034 - הקש את מספר ההודעה ולסיום הקש סולמית
    const msgId = await call.read([MSG(34)], 'tap', { max_digits: 10, terminate_keys: ['#'] });

    if (!msgId) {
        await call.id_list_message([
            // 035 - לא הוקש מספר, שיחה טובה
            MSG(35),
            { type: 'go_to_folder', data: 'hangup' }
        ]);
        return;
    }

    try {
        await call.id_list_message([
            { type: 'file', data: `manager_messages/${msgId}` }
        ], { prependToNextAction: true });
    } catch (e) {
        if (isHangup(e)) {
            console.log('handleAdminMessages: call hangup, aborting flow');
            throw e; // מעבירים את השגיאה הלאה - שהיא תגיע ל-uncaughtErrorHandler/HangupError handler של הספרייה
        }
        console.error('admin messages error:', e.message);
        await call.id_list_message([
            // 036 - שגיאה בטעינת ההודעה, שיחה טובה
            MSG(36),
            { type: 'go_to_folder', data: '/' }
        ]);
        return;
    }

    // 037 - לשמיעת הודעה נוספת הקש 1, לסיום הקש 2
    const again = await call.read([MSG(37)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (again === '1') {
        await handleAdminMessages(call);
    } else {
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
    }
}

app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IVR Server running on port ${PORT}`));
