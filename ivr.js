const express = require('express');
const { YemotRouter } = require('yemot-router2');
const axios = require('axios');

const app = express();
const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';
const YEMOT_USERNAME = process.env.YEMOT_USERNAME || '';
const YEMOT_PASSWORD = process.env.YEMOT_PASSWORD || '';

const router = YemotRouter({ printLog: true });

// מיפוי מקשים לאותיות — כמו טלפון כשר
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
    '0': ['@', '_', '-', '0'],
};

// המרת רצף הקשות למייל
// * מפריד בין מקשים עוקבים
function decodeEmail(input) {
    // מפצל לפי * שהוא מפריד
    const parts = input.split('*');
    let result = '';
    for (const part of parts) {
        if (!part) continue;
        const key = part[0];
        const count = part.length;
        if (KEY_MAP[key]) {
            const chars = KEY_MAP[key];
            result += chars[(count - 1) % chars.length];
        }
    }
    return result;
}

router.get('/', async (call) => {
    const phone = call.ApiPhone;

    let customer = null;
    let welcomeMsg = 'שלום וברוכים הבאים למערכת התמלול';
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
        if (customer.is_blocked) {
            await call.id_list_message([{
                type: 'text',
                data: 'מצטערים חשבונך חסום לפרטים פנה לשירות לקוחות'
            }]);
            return;
        }
        if (customer.balance > 0) {
            const balance = Math.floor(customer.balance);
            welcomeMsg += ` יתרתך היא ${balance} שקל`;
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

async function getEmailByKeypad(call) {
    await call.id_list_message([{
        type: 'text',
        data: 'הקלד את כתובת המייל שלך לפי מקשי הטלפון להפרדה בין מקשים עוקבים הקש כוכבית לסיום הקש סולמית'
    }]);

    const input = await call.read([{
        type: 'text',
        data: 'מתחיל הקלדה'
    }], 'tap', { max_digits: 50, terminate_keys: ['#'] });

    const email = decodeEmail(input);
    console.log('email input:', input, '-> decoded:', email);

    // קריאה לאישור
    await call.id_list_message([{
        type: 'text',
        data: `המייל שהוקלד הוא ${email} לאישור הקש 1 להקלדה מחדש הקש 2`
    }]);

    const confirm = await call.read([{
        type: 'text',
        data: ''
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (confirm === '1') {
        return email;
    } else {
        return await getEmailByKeypad(call);
    }
}

async function handleRecording(call, phone, customer) {
    const minBalance = 0;
    if (customer && customer.balance <= minBalance) {
        const choice = await call.read([{
            type: 'text',
            data: 'יתרתך נמוכה למעבר לטעינת ארנק הקש 1 להמשך ללא תשלום הקש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (choice === '1') {
            await call.id_list_message([{
                type: 'text',
                data: 'לטעינת ארנק פנה למנהל המערכת שיחה טובה'
            }]);
            return;
        }
    }

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
        fullRecUrl = `https://www.call2all.co.il/ym/api/DownloadFile?username=${YEMOT_USERNAME}&password=${YEMOT_PASSWORD}&path=ivr2:${recPath}`;
    }
    console.log('fullRecUrl:', fullRecUrl);

    let deliveryMethod = customer ? customer.delivery_method : 'email';
    let deliveredTo = customer ? (customer.email || customer.fax || '') : '';

    if (!deliveredTo) {
        const deliveryChoice = await call.read([{
            type: 'text',
            data: 'ההקלטה התקבלה לשליחה למייל הקש 1 לשליחה לפקס הקש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (deliveryChoice === '1') {
            const email = await getEmailByKeypad(call);
            deliveryMethod = 'email';
            deliveredTo = email;
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, {
                    phone, email, delivery_method: 'email'
                });
            } catch (e) {}
        } else {
            const fax = await call.read([{
                type: 'text',
                data: 'הקש את מספר הפקס שלך ולאחר מכן הקש סולמית'
            }], 'tap', { max_digits: 15 });
            deliveryMethod = 'fax';
            deliveredTo = fax;
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, {
                    phone, fax, delivery_method: 'fax'
                });
            } catch (e) {}
        }
    }

    try {
        await axios.post(`${PYTHON_URL}/api/transcribe`, {
            phone,
            rec_url: fullRecUrl,
            call_id: call.ApiCallId,
            delivery_method: deliveryMethod,
            delivered_to: deliveredTo
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
        await call.id_list_message([{
            type: 'text',
            data: 'לטעינת ארנק פנה למנהל המערכת שיחה טובה'
        }]);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else if (choice === '3') {
        await call.id_list_message([{
            type: 'text',
            data: 'מערכת זו מאפשרת להקליט הודעות שיתומללו ויישלחו אליך למייל או לפקס שיחה טובה'
        }]);
    } else {
        await call.go_to_folder('/');
    }
}

async function handleUpdateDetails(call, phone) {
    const choice = await call.read([{
        type: 'text',
        data: 'לעדכון מייל הקש 1 לעדכון פקס הקש 2 לחזרה הקש 0'
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2] });

    if (choice === '1') {
        const email = await getEmailByKeypad(call);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, {
                phone, email, delivery_method: 'email'
            });
        } catch (e) {}
        await call.id_list_message([{
            type: 'text',
            data: 'המייל עודכן בהצלחה שיחה טובה'
        }]);
    } else if (choice === '2') {
        const fax = await call.read([{
            type: 'text',
            data: 'הקש את מספר הפקס שלך ולאחר מכן הקש סולמית'
        }], 'tap', { max_digits: 15 });
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, {
                phone, fax, delivery_method: 'fax'
            });
        } catch (e) {}
        await call.id_list_message([{
            type: 'text',
            data: 'הפקס עודכן בהצלחה שיחה טובה'
        }]);
    } else {
        await handleOptions(call, phone);
    }
}

app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IVR Server running on port ${PORT}`));
