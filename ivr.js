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

    // ללא ניקוד - ימות לא מסתדר עם תווי ניקוד
    const letterNames = {
        'a': 'a',
        'b': 'b',
        'c': 'c',
        'd': 'd',
        'e': 'e',
        'f': 'f',
        'g': 'g',
        'h': 'h',
        'i': 'i',
        'j': 'j',
        'k': 'k',
        'l': 'l',
        'm': 'm',
        'n': 'n',
        'o': 'o',
        'p': 'p',
        'q': 'q',
        'r': 'r',
        's': 's',
        't': 't',
        'u': 'u',
        'v': 'v',
        'w': 'w',
        'x': 'x',
        'y': 'y',
        'z': 'z'
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

async function getEmailByKeypad(call) {
    const helpChoice = await call.read([{
        type: 'text',
        data: 'להוראות כתיבה הקש 1 להתחיל להקליד הקש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (helpChoice === '1') {
        await call.id_list_message([{
            type: 'text',
            data: 'יש להקליד לפי מקשי הטלפון לאות A הקישו 2 פעם אחת לאות B הקישו 2 פעמיים לאות C הקישו 2 שלוש פעמים לספרה 2 הקישו 2 ארבע פעמים לאות D הקישו 3 פעם אחת לאות E הקישו 3 פעמיים לאות F הקישו 3 שלוש פעמים לספרה 3 הקישו 3 ארבע פעמים לנקודה הקישו 1 פעם אחת לספרה 1 הקישו 1 פעמיים לספרה 0 הקישו 0 פעם אחת'
        }]);
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
            await call.id_list_message([{ type: 'text', data: 'לא הצלחנו לזהות את שם המייל נסו שוב' }]);
            return await getEmailByVoice(call);
        }

        return await getDomainAndConfirmEmail(call, localPart, 'הקלטה');

    } catch (e) {
        console.error('extract email error:', e.message);
        await call.id_list_message([{ type: 'text', data: 'אירעה שגיאה עוברים למצב כתיבה' }]);
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
        const res = await axios.post(`${PYTHON_URL}/api/extract-email-local`, { rec_url: recUrl });
        const domain = res.data.local_part || '';

        if (!domain) {
            await call.id_list_message([{ type: 'text', data: 'לא הצלחנו לזהות את הסיומת נסו שוב' }]);
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
            await call.id_list_message([{ type: 'text', data: 'מצטערים חשבונך חסום לפרטים פנה לשירות לקוחות' }]);
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

    const choice = await call.read([{
        type: 'text',
        data: `${welcomeMsg} להתחלת הקלטה הקש 1 לתפריט אפשרויות הקש 2`
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (choice === '1') {
        await handleRecording(call, phone, customer);
    } else {
        await handleOptions(call, phone);
    }
});

async function handleRecording(call, phone, customer) {
    const minBalance = 0;
    if (customer && customer.balance <= minBalance) {
        const choice = await call.read([{
            type: 'text',
            data: 'יתרתך נמוכה למעבר לטעינת ארנק הקש 1 להמשך ללא תשלום הקש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (choice === '1') {
            await call.id_list_message([{ type: 'text', data: 'לטעינת ארנק פנה למנהל המערכת שיחה טובה' }]);
            return;
        }
    }

    const tierChoice = await call.read([{
        type: 'text',
        data: 'לתמלול רגיל הקש 1 לתמלול מקצועי עם זיהוי מושגים תורניים וארמית הקש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    const transcriptionTier = tierChoice === '2' ? 'premium' : 'basic';

    const recPath = await call.read([{
        type: 'text',
        data: 'השאר את הודעתך לאחר הצליל לסיום הקש סולמית או נתק'
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
            data: 'לשליחה למייל הקש 1 לשליחה לפקס הקש 2'
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
                data: 'הקש את מספר הפקס שלך ולאחר מכן הקש סולמית'
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
            transcription_tier: transcriptionTier
        });
    } catch (e) {
        console.error('transcribe error:', e.message);
    }

    await call.id_list_message([{
        type: 'text',
        data: 'ההקלטה התקבלה התמלול ישלח אליך בקרוב שיחה טובה'
    }]);
}

async function handleOptions(call, phone) {
    const choice = await call.read([{
        type: 'text',
        data: 'לטעינת ארנק הקש 1 לעדכון פרטים הקש 2 להסבר על המערכת הקש 3 לחזרה הקש 0'
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3] });

    if (choice === '1') {
        await call.id_list_message([{ type: 'text', data: 'לטעינת ארנק פנה למנהל המערכת שיחה טובה' }]);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else if (choice === '3') {
        await call.id_list_message([{ type: 'text', data: 'מערכת זו מאפשרת להקליט הודעות שיתומללו ויישלחו אליך למייל או לפקס שיחה טובה' }]);
    } else {
        await call.id_list_message([{ type: 'text', data: 'להתחלה חייג שוב שיחה טובה' }]);
    }
}

async function handleUpdateDetails(call, phone) {
    // טוען נתוני לקוח עדכניים בכל כניסה לתפריט
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
        // מודיע ואז חוזר לתפריט עדכון פרטים
        await call.id_list_message([{ type: 'text', data: 'המייל עודכן בהצלחה' }]);
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
        // מודיע ואז חוזר לתפריט עדכון פרטים
        await call.id_list_message([{ type: 'text', data: 'הפקס עודכן בהצלחה' }]);
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
            await call.id_list_message([{ type: 'text', data: 'שיטת השליחה עודכנה למייל' }]);
        } else {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'fax' });
            } catch (e) {}
            await call.id_list_message([{ type: 'text', data: 'שיטת השליחה עודכנה לפקס' }]);
        }
        // חוזר לתפריט עדכון פרטים
        return await handleUpdateDetails(call, phone);

    } else {
        // 0 = חזרה לתפריט אפשרויות
        await handleOptions(call, phone);
    }
}

app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IVR Server running on port ${PORT}`));
