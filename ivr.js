const express = require('express');
const { YemotRouter } = require('yemot-router2');
const axios = require('axios');

const app = express();
const PYTHON_URL = process.env.PYTHON_URL || 'https://web-production-90272.up.railway.app';

const router = YemotRouter({ printLog: true });

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
            welcomeMsg += ` יתרתך היא ${customer.balance} שקל`;
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
        fullRecUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${process.env.YEMOT_TOKEN}&path=ivr2:${recPath}`;
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
            const email = await call.read([{
                type: 'text',
                data: 'אמור בקול ברור את כתובת המייל שלך'
            }], 'stt');
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
        const email = await call.read([{
            type: 'text',
            data: 'אמור בקול ברור את כתובת המייל שלך'
        }], 'stt');
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
