const express = require('express');
const { YemotRouter } = require('yemot-router2');
const axios = require('axios');

const app = express();
const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';

const router = YemotRouter({ printLog: true });

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

function speakDigits(value) {
    return String(value || '').split('').join(' ');
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

async function getEmailByVoice(call) {
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
            // 049 - לא הצלחנו לזהות את שם המייל, נסו שוב
            await call.id_list_message([MSG(49)], { prependToNextAction: true });
            return await getEmailByVoice(call);
        }

        return await getDomainAndConfirmEmail(call, localPart, 'הקלטה');

    } catch (e) {
        console.error('extract email error:', e.message);
        // 050 - אירעה שגיאה, עוברים למצב כתיבה
        await call.id_list_message([MSG(50)], { prependToNextAction: true });
        return await getEmailByKeypad(call);
    }
}

async function getDomainByVoice(call) {
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
            // 052 - לא הצלחנו לזהות את הסיומת, נסו שוב
            await call.id_list_message([MSG(52)], { prependToNextAction: true });
            return await getDomainByVoice(call);
        }

        const domainSpoken = speakEmail('@' + domain).replace('שטרודל ', '');
        // 053 - הסיומת שזוהתה היא [דינמי] + 054 - לאישור הקש 1, לניסיון מחדש הקש 2
        const confirm = await call.read([
            MSG(53),
            { type: 'text', data: domainSpoken },
            MSG(54)
        ], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (confirm === '1') return domain;
        return await getDomainByVoice(call);

    } catch (e) {
        console.error('extract domain error:', e.message);
        return await getDomainByVoice(call);
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
    const emailSpoken = speakEmail(email);

    const confirm = await call.read([
        MSG(66), // המייל שהתקבל הוא
        { type: 'text', data: emailSpoken },
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
    const phone = call.ApiPhone;

    let customer = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
        if (customer.is_blocked) {
            await call.id_list_message([
                // 005 - מצטערים, חשבונך חסום, לפרטים פנה לשירות לקוחות
                MSG(5),
                { type: 'go_to_folder', data: 'hangup' }
            ]);
            return;
        }
    } catch (e) {
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
    }

    // בדוק הקלטות ממתינות לתשלום
    try {
        const pendingRes = await axios.get(`${PYTHON_URL}/api/customer/pending-recordings?phone=${phone}`);
        const pending = pendingRes.data;
        if (pending.has_pending) {
            if (pending.enough_balance) {
                // יש יתרה עכשיו - הפעל תמלול אוטומטית
                await axios.post(`${PYTHON_URL}/api/process-pending`, { phone });
                await call.id_list_message([
                    MSG(77),  // נמצאה הקלטה ממתינה באורך
                    { type: 'text', data: String(pending.minutes) },
                    MSG(81),  // דקות, יש לך עכשיו יתרה מספיקה, התמלול יתחיל עכשיו וישלח אליך בקרוב
                ], { prependToNextAction: true });
            } else {
                // עדיין אין יתרה מספיקה
                await call.id_list_message([
                    MSG(77),  // נמצאה הקלטה ממתינה באורך
                    { type: 'text', data: String(pending.minutes) },
                    MSG(78),  // דקות, העלות היא
                    { type: 'text', data: String(pending.cost) },
                    MSG(79),  // שקל, יתרתך היא
                    { type: 'text', data: String(pending.balance) },
                    MSG(80),  // שקל, אנא טען ארנק כדי שהתמלול יבוצע
                ], { prependToNextAction: true });
            }
        }
    } catch (e) {
        console.error('pending check error:', e.message);
    }

    const ADMIN_PHONE = '0527134491';
    const allowedDigits = phone === ADMIN_PHONE ? [0, 1, 2, 3, 4, 5, 6, 9] : [1, 2, 3, 4, 5, 6, 9];

    const choice = await call.read([
        MSG(1),   // 001 - שלום, ברוכים הבאים למערכת התמלול
        MSG(2),   // 002 - קובץ ריק — הודעה זמנית לכניסה
        ...balanceParts,
        MSG(4),   // 004 - תפריט ראשי: הקש 1... הקש 9
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
    } else if (choice === '9') {
        await handleManagerMessage(call, phone, customer);
    } else if (choice === '0' && phone === ADMIN_PHONE) {
        await handleAdminMessages(call);
    } else {
        await handleOptions(call, phone);
    }
});

async function handleEmailInstructions(call, phone, customer) {
    const hasEmail = !!(customer && customer.email);
    const phoneSpoken = speakDigits(phone);

    if (hasEmail) {
        const choice = await call.read([
            // 041 - הסבר שלוחה 5 עד לפני מספר הטלפון
            MSG(41),
            { type: 'text', data: phoneSpoken },
            // 042 - המשך הסבר שלוחה 5 + הקש 1 לקבלת הוראות, הקש 0 לחזרה
            MSG(42),
        ], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/send-email-instructions`, { phone });
                await call.id_list_message([
                    // 038 - ההוראות המפורטות נשלחו לכתובת המייל שלך, שיחה טובה
                    MSG(38),
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                console.error('send-email-instructions error:', e.message);
                await call.id_list_message([
                    // 039 - אירעה שגיאה בשליחת ההוראות, שיחה טובה
                    MSG(39),
                    { type: 'go_to_folder', data: '/' }
                ]);
            }
            return;
        }

        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);

    } else {
        await call.id_list_message([
            // 041 - הסבר שלוחה 5 עד לפני מספר הטלפון
            MSG(41),
            { type: 'text', data: phoneSpoken },
            // 040 - כדי לקבל הוראות מפורטות במייל יש לעדכן קודם כתובת מייל...
            MSG(40),
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleHandwritingInstructions(call, phone, customer) {
    const hasEmail = !!(customer && customer.email);
    const phoneSpoken = speakDigits(phone);

    if (hasEmail) {
        const choice = await call.read([
            // 043 - הסבר שלוחה 6 עד לפני מספר הטלפון
            MSG(43),
            { type: 'text', data: phoneSpoken },
            // 044 - המשך הסבר שלוחה 6 + הקש 1 לקבלת הוראות, הקש 0 לחזרה
            MSG(44),
        ], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/send-handwriting-instructions`, { phone });
                await call.id_list_message([
                    // 038 - ההוראות המפורטות נשלחו לכתובת המייל שלך, שיחה טובה
                    MSG(38),
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                console.error('send-handwriting-instructions error:', e.message);
                await call.id_list_message([
                    // 039 - אירעה שגיאה בשליחת ההוראות, שיחה טובה
                    MSG(39),
                    { type: 'go_to_folder', data: '/' }
                ]);
            }
            return;
        }

        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);

    } else {
        await call.id_list_message([
            // 043 - הסבר שלוחה 6 עד לפני מספר הטלפון
            MSG(43),
            { type: 'text', data: phoneSpoken },
            // 040 - כדי לקבל הוראות מפורטות במייל יש לעדכן קודם כתובת מייל...
            MSG(40),
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleManagerMessage(call, phone, customer) {
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
    const recPath = await call.read([MSG(9), MSG(10)], 'record', {
        no_confirm_menu: true,
        save_on_hangup: true,
        path: '/manager_messages',
        file_name: String(msgId)
    });

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
        await call.id_list_message([
            MSG(16),
            { type: 'text', data: balanceStr },
            MSG(17),
            transcriptionTier === 'premium' ? MSG(59) : MSG(58),
            MSG(18),
            { type: 'text', data: String(requiredPrice) },
            MSG(19),
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
    const recPath = await call.read([MSG(23)], 'record', {
        no_confirm_menu: true,
        save_on_hangup: true,
        path: '/recordings'
    });

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
    // 027 - לטעינת ארנק הקש 1, לעדכון פרטים הקש 2, לחזרה הקש 0
    const choice = await call.read([MSG(27)], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2] });

    if (choice === '1') {
        await handleTopUp(call, phone);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else {
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
    }
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

    const emailSpoken = customer && customer.email ? speakEmail(customer.email) : '';
    const emailParts = emailSpoken
        ? [MSG(68), { type: 'text', data: emailSpoken }] // המייל שלך הוא [דינמי]
        : [MSG(74)]; // לא מעודכן מייל
    const faxParts = (customer && customer.fax)
        ? [MSG(69), { type: 'text', data: customer.fax }] // הפקס שלך הוא [דינמי]
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
            { type: 'text', data: fax },
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

    const tierName = currentDefaults.tier === 'premium' ? 'תמלול מקצועי' : 'תמלול רגיל';
    const langName = currentDefaults.language === 'yi' ? 'יידיש' : currentDefaults.language === 'en' ? 'אנגלית' : 'עברית';
    const outLangName = currentDefaults.output_language === 'yi' ? 'יידיש' : currentDefaults.output_language === 'en' ? 'אנגלית' : 'עברית';

    const choice = await call.read([
        MSG(85), // ברירת המחדל הנוכחית שלך היא
        { type: 'text', data: `${tierName}, שפת הקלטה ${langName}, שפת פלט ${outLangName}` },
        MSG(86), // לשינוי סוג תמלול הקש 1, לשינוי שפת הקלטה הקש 2, לשינוי שפת פלט הקש 3, לחזרה הקש 0
    ], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3] });

    if (choice === '0') return;

    let newDefaults = { ...currentDefaults };

    if (choice === '1') {
        // שינוי סוג תמלול
        const t = await call.read([MSG(15)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        newDefaults.tier = t === '2' ? 'premium' : 'gemini';
    } else if (choice === '2') {
        // שינוי שפת הקלטה
        const l = await call.read([MSG(20)], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });
        newDefaults.language = l === '2' ? 'yi' : l === '3' ? 'en' : 'he';
        // איפוס שפת פלט להתאמה
        newDefaults.output_language = newDefaults.language;
    } else if (choice === '3') {
        // שינוי שפת פלט — לפי שפת ההקלטה הנוכחית
        const lang = currentDefaults.language || 'he';
        if (lang === 'yi') {
            const o = await call.read([MSG(21)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            // 021: הקש 1 = יידיש, הקש 2 = עברית
            newDefaults.output_language = o === '1' ? 'yi' : 'he';
        } else if (lang === 'en') {
            const o = await call.read([MSG(22)], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            // 022: הקש 1 = אנגלית, הקש 2 = עברית
            newDefaults.output_language = o === '1' ? 'en' : 'he';
        } else {
            // עברית — שפת פלט תמיד עברית
            newDefaults.output_language = 'he';
        }
    }

    try {
        await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, default_settings: newDefaults });
        await call.id_list_message([MSG(87)], { prependToNextAction: true }); // ברירת המחדל עודכנה
    } catch (e) {
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
    const recPath = await call.read([MSG(23)], 'record', {
        no_confirm_menu: true,
        save_on_hangup: true,
        path: '/recordings'
    });

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
        console.error('admin messages error:', e.message);
        if (!e.message.includes('hangup')) {
            await call.id_list_message([
                // 036 - שגיאה בטעינת ההודעה, שיחה טובה
                MSG(36),
                { type: 'go_to_folder', data: '/' }
            ]);
        }
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
