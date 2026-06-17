const express = require('express');
const { YemotRouter } = require('yemot-router2');
const axios = require('axios');

const app = express();
const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';

const router = YemotRouter({ printLog: true });

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
    const helpChoice = await call.read([{
        type: 'text',
        data: 'להוראות כתיבה הקש 1 להתחיל להקליד הקש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (helpChoice === '1') {
        await call.id_list_message([{
            type: 'text',
            data: 'יש להקליד לפי מקשי הטלפון לאות A הקישו 2 פעם אחת לאות B הקישו 2 פעמיים לאות C הקישו 2 שלוש פעמים לספרה 2 הקישו 2 ארבע פעמים לאות D הקישו 3 פעם אחת לאות E הקישו 3 פעמיים לאות F הקישו 3 שלוש פעמים לספרה 3 הקישו 3 ארבע פעמים לנקודה הקישו 1 פעם אחת לספרה 1 הקישו 1 פעמיים לספרה 0 הקישו 0 פעם אחת'
        }], { prependToNextAction: true });
    }

    const input = await call.read([{
        type: 'text',
        data: 'הקלד את כתובת המייל עד השטרודל ולסיום הקש סולמית'
    }], 'tap', { max_digits: 100, sec_wait: 7, terminate_keys: ['#'] });

    const localPart = decodeEmail(input);
    return await getDomainAndConfirmEmail(call, localPart, 'כתיבה');
}

async function getEmailByVoice(call) {
    const recPath = await call.read([{
        type: 'text',
        data: 'הקליט את שם המייל שלך עד השטרודל לאחר הצליל ולסיום הקש סולמית שים לב ייתכן והזיהוי לא יהיה מדויק'
    }], 'record', {
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
            await call.id_list_message([{ type: 'text', data: 'לא הצלחנו לזהות את שם המייל נסו שוב' }], { prependToNextAction: true });
            return await getEmailByVoice(call);
        }

        return await getDomainAndConfirmEmail(call, localPart, 'הקלטה');

    } catch (e) {
        console.error('extract email error:', e.message);
        await call.id_list_message([{ type: 'text', data: 'אירעה שגיאה עוברים למצב כתיבה' }], { prependToNextAction: true });
        return await getEmailByKeypad(call);
    }
}

async function getDomainByVoice(call) {
    const recPath = await call.read([{
        type: 'text',
        data: 'הקליט את סיומת המייל לאחר הצליל ולסיום הקש סולמית לדוגמה הקליט יאהו נקודה קום'
    }], 'record', {
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
            await call.id_list_message([{ type: 'text', data: 'לא הצלחנו לזהות את הסיומת נסו שוב' }], { prependToNextAction: true });
            return await getDomainByVoice(call);
        }

        const domainSpoken = speakEmail('@' + domain).replace('שטרודל ', '');
        const confirm = await call.read([{
            type: 'text',
            data: `הסיומת שזוהתה היא ${domainSpoken} לאישור הקש 1 לניסיון מחדש הקש 2`
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (confirm === '1') return domain;
        return await getDomainByVoice(call);

    } catch (e) {
        console.error('extract domain error:', e.message);
        return await getDomainByVoice(call);
    }
}

async function getDomainAndConfirmEmail(call, localPart, mode) {
    const domainChoice = await call.read([{
        type: 'text',
        data: 'לסיומת גימייל נקודה קום הקש 1 לסיומת יאהו נקודה קום הקש 2 לסיומת וואלה נקודה קום הקש 3 לסיומת הוטמייל נקודה קום הקש 4 לסיומת אחרת הקש 5'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3, 4, 5] });

    const domains = { '1': 'gmail.com', '2': 'yahoo.com', '3': 'walla.com', '4': 'hotmail.com' };

    let domain = '';
    if (domainChoice === '5') {
        if (mode === 'הקלטה') {
            domain = await getDomainByVoice(call);
        } else {
            const domainPart = await call.read([{
                type: 'text',
                data: 'הקלד את הסיומת ולסיום הקש סולמית'
            }], 'tap', { max_digits: 50, terminate_keys: ['#'] });
            domain = decodeEmail(domainPart);
        }
    } else {
        domain = domains[domainChoice];
    }

    const email = `${localPart}@${domain}`;
    const emailSpoken = speakEmail(email);

    const confirm = await call.read([{
        type: 'text',
        data: `המייל שהתקבל הוא ${emailSpoken} לאישור הקש 1 לתיקון הקש 2`
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (confirm === '1') return email;
    if (mode === 'הקלטה') return await getEmailByVoice(call);
    return await getEmailByKeypad(call);
}

async function getEmail(call) {
    const modeChoice = await call.read([{
        type: 'text',
        data: 'למצב הקלטה הקש 1 למצב כתיבה הקש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (modeChoice === '1') {
        return await getEmailByVoice(call);
    } else {
        return await getEmailByKeypad(call);
    }
}

router.get('/', async (call) => {
    const phone = call.ApiPhone;

    let customer = null;
    let welcomeMsg = 'שלום וברוכים הבאים למערכת התמלול';
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
        if (customer.is_blocked) {
            await call.id_list_message([
                { type: 'text', data: 'מצטערים חשבונך חסום לפרטים פנה לשירות לקוחות' },
                { type: 'go_to_folder', data: 'hangup' }
            ]);
            return;
        }
        if (customer.balance > 0) {
            const balanceShekel = Math.floor(customer.balance);
            const balanceAgorot = Math.round((customer.balance - balanceShekel) * 100);
            if (balanceAgorot > 0) {
                welcomeMsg += ` יתרתך היא ${balanceShekel} שקל ו ${balanceAgorot} אגורות`;
            } else {
                welcomeMsg += ` יתרתך היא ${balanceShekel} שקל`;
            }
        }
    } catch (e) {
        console.error('customer error:', e.message);
    }

    const ADMIN_PHONE = '0527134491';
    const allowedDigits = phone === ADMIN_PHONE ? [0, 1, 2, 3, 5, 9] : [1, 2, 3, 5, 9];

    const choice = await call.read([{
        type: 'text',
        data: `${welcomeMsg} להתחלת הקלטה הקש 1 לתפריט אפשרויות הקש 2 להסבר על המערכת הקש 3 לשליחת הקלטה במייל הקש 5 להשארת הודעה למנהל הקש 9`
    }], 'tap', { max_digits: 1, digits_allowed: allowedDigits });

    if (choice === '1') {
        await handleRecording(call, phone, customer);
    } else if (choice === '3') {
        await call.id_list_message([
            { type: 'text', data: 'מערכת זו מאפשרת להקליט הודעות שיתומללו ויישלחו אליך למייל או לפקס שיחה טובה' },
            { type: 'go_to_folder', data: '/' }
        ]);
    } else if (choice === '5') {
        await handleEmailInstructions(call, phone, customer);
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

    const explainMsg =
        'ניתן לשלוח הקלטה לתמלול גם באמצעות מייל ' +
        'בלי להתקשר למערכת שולחים מייל עם קובץ ההקלטה מצורף לכתובת המייל של המערכת ' +
        'ובשורת הנושא של המייל כותבים את מספר הטלפון שלך ' +
        `כלומר ${phoneSpoken} ` +
        'אפשר גם לציין בשורת הנושא אחרי המספר את סוג התמלול ואת שפת ההקלטה ושפת הפלט הרצויה ' +
        'התמלול יישלח בחזרה לאותה כתובת מייל שממנה נשלחה ההקלטה ' +
        'שימוש זה מתאפשר רק מכתובת מייל הרשומה ומעודכנת במערכת ובתנאי שיש יתרה בארנק';

    if (hasEmail) {
        const choice = await call.read([{
            type: 'text',
            data: `${explainMsg} לקבלת הוראות מפורטות עם דוגמאות וקישור ישיר למייל הקש 1 לחזרה לתפריט הראשי הקש 0`
        }], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/send-email-instructions`, { phone });
                await call.id_list_message([
                    { type: 'text', data: 'ההוראות המפורטות נשלחו לכתובת המייל שלך שיחה טובה' },
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                console.error('send-email-instructions error:', e.message);
                await call.id_list_message([
                    { type: 'text', data: 'אירעה שגיאה בשליחת ההוראות שיחה טובה' },
                    { type: 'go_to_folder', data: '/' }
                ]);
            }
            return;
        }

        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);

    } else {
        await call.id_list_message([
            {
                type: 'text',
                data: `${explainMsg} כדי לקבל הוראות מפורטות במייל יש לעדכן קודם כתובת מייל בתפריט עדכון פרטים באמצעות תפריט אפשרויות`
            },
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleManagerMessage(call, phone, customer) {
    // קבל מספר ID לפני ההקלטה
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

    const recPath = await call.read([{
        type: 'text',
        data: 'השאר הודעתך למנהל לאחר הצליל לסיום הקש סולמית'
    }], 'record', {
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
        { type: 'text', data: 'הודעתך התקבלה המנהל יחזור אליך בהקדם שיחה טובה' },
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleRecording(call, phone, customer) {
    const balance = customer ? parseFloat(customer.balance || 0) : 0;

    // משיכת מחירים מהשרת
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

    // בדיקה ראשונה: יתרה נמוכה מהמחיר הזול ביותר - חסום לחלוטין
    if (balance < minPrice) {
        if (balance <= 0) {
            await call.id_list_message([
                { type: 'text', data: 'מצטערים, אין יתרה בארנק שלך, לטעינת ארנק חזור לתפריט הראשי והֵקֵש 2, שיחה טובה' },
                { type: 'go_to_folder', data: '/' }
            ]);
        } else {
            const balanceShekel = Math.floor(balance);
            const balanceAgorot = Math.round((balance - balanceShekel) * 100);
            const balanceStr = balanceAgorot > 0
                ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
                : `${balanceShekel} שקל`;
            await call.id_list_message([
                { type: 'text', data: `מצטערים, יתרתך ${balanceStr} אינה מספיקה לתמלול, לטעינת ארנק חזור לתפריט הראשי והֵקֵש 2, שיחה טובה` },
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    // התראה על יתרה נמוכה (מתחת ל-10 ₪) - אפשר להמשיך
    if (balance < 10) {
        const balanceShekel = Math.floor(balance);
        const balanceAgorot = Math.round((balance - balanceShekel) * 100);
        const balanceStr = balanceAgorot > 0
            ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
            : `${balanceShekel} שקל`;

        const choice = await call.read([{
            type: 'text',
            data: `שים לב, יתרתך נמוכה, ${balanceStr} בלבד, להמשך הקלטה הֵקֵש 1, לחזרה לתפריט הֵקֵש 0`
        }], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '0') {
            await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
            return;
        }
    }

    // בחירת סוג תמלול
    const tierChoice = await call.read([{
        type: 'text',
        data: 'לתמלול רגיל הֵקֵש 1, לתמלול מקצועי הֵקֵש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    const transcriptionTier = tierChoice === '2' ? 'premium' : 'gemini';

    // בדיקה שניה: יתרה מספיקה לסוג התמלול שנבחר
    const requiredPrice = transcriptionTier === 'premium' ? pricePremium : priceBasic;
    if (balance < requiredPrice) {
        const balanceShekel = Math.floor(balance);
        const balanceAgorot = Math.round((balance - balanceShekel) * 100);
        const balanceStr = balanceAgorot > 0
            ? `${balanceShekel} שקל ו ${balanceAgorot} אגורות`
            : `${balanceShekel} שקל`;
        const tierName = transcriptionTier === 'premium' ? 'תמלול מקצועי' : 'תמלול רגיל';
        await call.id_list_message([
            { type: 'text', data: `יתרתך ${balanceStr} אינה מספיקה ל${tierName} העולה ${requiredPrice} שקל, לחזרה לתפריט הֵקֵש כל מקש` },
            { type: 'go_to_folder', data: '/' }
        ]);
        return;
    }

    // בחירת שפה
    let language = 'he';
    let outputLanguage = 'he';
    const langChoice = await call.read([{
        type: 'text',
        data: 'לתמלול בעברית הֵקֵש 1, ביידיש הֵקֵש 2, באנגלית הֵקֵש 3'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });

    language = langChoice === '2' ? 'yi' : langChoice === '3' ? 'en' : 'he';

    if (language === 'yi') {
        const outChoice = await call.read([{
            type: 'text',
            data: 'לקבל את התמלול ביידיש הֵקֵש 1, בעברית הֵקֵש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        outputLanguage = outChoice === '2' ? 'he' : 'yi';
    } else if (language === 'en') {
        const outChoice = await call.read([{
            type: 'text',
            data: 'לקבל את התמלול באנגלית הֵקֵש 1, בעברית הֵקֵש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        outputLanguage = outChoice === '2' ? 'he' : 'en';
    }

    const recPath = await call.read([{
        type: 'text',
        data: 'השאר את הודעתך לאחר הצליל, לסיום הֵקֵש סולמית או נתק'
    }], 'record', {
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
        const deliveryChoice = await call.read([{
            type: 'text',
            data: 'לשליחה למייל הֵקֵש 1, לשליחה לפקס הֵקֵש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (deliveryChoice === '1') {
            const email = await getEmail(call);
            deliveryMethod = 'email';
            deliveredTo = email;
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' });
            } catch (e) {}
        } else {
            const fax = await call.read([{
                type: 'text',
                data: 'הֵקֵש את מספר הפקס שלך, ולאחר מכן הֵקֵש סולמית'
            }], 'tap', { max_digits: 15, terminate_keys: ['#'] });
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
        { type: 'text', data: 'ההקלטה התקבלה התמלול ישלח אליך בקרוב שיחה טובה' },
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleOptions(call, phone) {
    const choice = await call.read([{
        type: 'text',
        data: 'לטעינת ארנק הֵקֵש 1, לעדכון פרטים הֵקֵש 2, לחזרה הֵקֵש 0'
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2] });

    if (choice === '1') {
        await handleTopUp(call, phone);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else {
        await call.id_list_message([
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleTopUp(call, phone) {
    // משיכת הגדרות בונוס מהשרת
    let bonusMsg = '';
    try {
        const settingsRes = await axios.get(`${PYTHON_URL}/api/settings`);
        const s = settingsRes.data;
        for (let i = 1; i <= 3; i++) {
            const threshold = parseFloat(s[`bonus_threshold_${i}`] || 0);
            const bonus = parseFloat(s[`bonus_amount_${i}`] || 0);
            if (threshold > 0 && bonus > 0) {
                bonusMsg = `, שים לב, מבצע מיוחד, טעינה מ ${threshold} שקל, מקנה בונוס של ${bonus} שקל נוספים`;
                break;
            }
        }
    } catch (e) {
        console.error('could not fetch settings for topup:', e.message);
    }

    // בקשת סכום מהלקוח
    const amountStr = await call.read([{
        type: 'text',
        data: `הכנס את הסכום לטעינה במספרים, מינימום 20 שקל${bonusMsg}, ולאישור הֵקֵש סולמית`
    }], 'tap', { max_digits: 5, terminate_keys: ['#'] });

    const amount = parseInt(amountStr || '0', 10);

    if (!amount || amount < 1) {
        await call.id_list_message([
            { type: 'text', data: `הסכום שהוקש ${amount || 0} שקל אינו תקין, סכום מינימום לטעינה הוא 20 שקל, חוזרים לתפריט` },
            { type: 'go_to_folder', data: '/' }
        ]);
        return;
    }

    // אישור סכום
    const confirm = await call.read([{
        type: 'text',
        data: `הסכום לטעינה הוא ${amount} שקל, לאישור ומעבר לסליקה הֵקֵש 1, לביטול הֵקֵש 0`
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

    if (confirm !== '1') {
        await call.id_list_message([{ type: 'go_to_folder', data: '/' }]);
        return;
    }

    // מעבר לשלוחת הסליקה של ימות
    await call.id_list_message([
        { type: 'text', data: 'עוברים לסליקה, תכף תתבקש להכניס את פרטי כרטיס האשראי שלך' },
        {
            type: 'go_to_folder',
            data: `payment?billing_sum=${amount}&Description=${phone}&credit_card_tashloumim=no`
        }
    ]);
}

async function handleUpdateDetails(call, phone) {
    let customer = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
    } catch (e) {}

    const emailSpoken = customer && customer.email ? speakEmail(customer.email) : '';
    const emailMsg = emailSpoken ? `המייל שלך הוא ${emailSpoken}` : 'לא מעודכן מייל';
    const faxMsg = customer && customer.fax ? `הפקס שלך הוא ${customer.fax}` : 'לא מעודכן פקס';
    const deliveryMsg = customer && customer.delivery_method === 'fax' ? 'שיטת השליחה היא פקס' : 'שיטת השליחה היא מייל';

    const choice = await call.read([{
        type: 'text',
        data: `${emailMsg} ${faxMsg} ${deliveryMsg} לעדכון מייל הקש 1 לעדכון פקס הקש 2 לשינוי שיטת שליחה הקש 3 לחזרה הקש 0`
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3] });

    if (choice === '1') {
        const email = await getEmail(call);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' });
        } catch (e) {}
        await call.id_list_message([{ type: 'text', data: 'המייל עודכן בהצלחה' }], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '2') {
        const fax = await call.read([{
            type: 'text',
            data: 'הקש את מספר הפקס שלך ולאחר מכן הקש סולמית'
        }], 'tap', { max_digits: 15, terminate_keys: ['#'] });
        const confirm = await call.read([{
            type: 'text',
            data: `מספר הפקס שהוקלד הוא ${fax} לאישור הקש 1 לתיקון הקש 2`
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        if (confirm === '2') return await handleUpdateDetails(call, phone);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax, delivery_method: 'fax' });
        } catch (e) {}
        await call.id_list_message([{ type: 'text', data: 'הפקס עודכן בהצלחה' }], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '3') {
        const methodChoice = await call.read([{
            type: 'text',
            data: 'לשליחה למייל הקש 1 לשליחה לפקס הקש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (methodChoice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'email' });
            } catch (e) {}
            await call.id_list_message([{ type: 'text', data: 'שיטת השליחה עודכנה למייל' }], { prependToNextAction: true });
        } else {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'fax' });
            } catch (e) {}
            await call.id_list_message([{ type: 'text', data: 'שיטת השליחה עודכנה לפקס' }], { prependToNextAction: true });
        }
        return await handleUpdateDetails(call, phone);

    } else {
        await handleOptions(call, phone);
    }
}

async function handleAdminMessages(call) {
    const msgId = await call.read([{
        type: 'text',
        data: 'הקש את מספר ההודעה ולסיום הקש סולמית'
    }], 'tap', { max_digits: 10, terminate_keys: ['#'] });

    if (!msgId) {
        await call.id_list_message([
            { type: 'text', data: 'לא הוקש מספר שיחה טובה' },
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
                { type: 'text', data: 'שגיאה בטעינת ההודעה שיחה טובה' },
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    const again = await call.read([{
        type: 'text',
        data: 'לשמיעת הודעה נוספת הקש 1 לסיום הקש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (again === '1') {
        await handleAdminMessages(call);
    } else {
        await call.id_list_message([
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}
app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IVR Server running on port ${PORT}`));
