const express = require('express');
const { YemotRouter } = require('yemot-router2');
const axios = require('axios');

const app = express();
const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';

const router = YemotRouter({ printLog: true });

router.get('/', async (call) => {
    const phone = call.ApiPhone;

    // קבלת פרטי לקוח
    let welcomeMsg = 'שלום וברוכים הבאים למערכת התמלול';
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        if (res.data && res.data.balance > 0) {
            welcomeMsg += ` יתרתך היא ${res.data.balance} שקל`;
        }
    } catch (e) {}

    const choice = await call.read([{
        type: 'text',
        data: `${welcomeMsg} להתחלת הקלטה הקש 1 לתפריט אפשרויות הקש 2`
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (choice === '1') {
        await handleRecording(call, phone);
    } else {
        await handleOptions(call, phone);
    }
});

async function handleRecording(call, phone) {
    const recPath = await call.read([{
        type: 'text',
        data: 'השאר את הודעתך לאחר הצליל לסיום הקש סולמית או נתק'
    }], 'record', { no_confirm_menu: true, save_on_hangup: true });

    try {
        await axios.post(`${PYTHON_URL}/api/transcribe`, {
            phone,
            rec_url: recPath,
            call_id: call.ApiCallId
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
        const email = await call.read([{
            type: 'text',
            data: 'אמור בקול ברור את כתובת המייל שלך'
        }], 'stt');
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email });
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
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax });
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
