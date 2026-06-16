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
        data: 'לְהוֹרָאוֹת כְּתִיבָה הֵקֵש 1, לְהַתְחִיל לְהַקְלִיד הֵקֵש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (helpChoice === '1') {
        await call.id_list_message([{
            type: 'text',
            data: 'יֵש לְהַקְלִיד לְפִי מַקְשֵׁי הַטֶּלֶפוֹן, לְאוֹת A הַקִּישׁוּ 2 פַּעַם אַחַת, לְאוֹת B הַקִּישׁוּ 2 פְּעָמַיִם, לְאוֹת C הַקִּישׁוּ 2 שָׁלוֹשׁ פְּעָמִים, לְסִפְרָה 2 הַקִּישׁוּ 2 אַרְבַּע פְּעָמִים, לְאוֹת D הַקִּישׁוּ 3 פַּעַם אַחַת, לְנְקוּדָּה הַקִּישׁוּ 1 פַּעַם אַחַת, לְסִפְרָה 0 הַקִּישׁוּ 0 פַּעַם אַחַת'
        }], { prependToNextAction: true });
    }

    const input = await call.read([{
        type: 'text',
        data: 'הַקְלֵד אֶת כְּתוֹבֶת הַמֵּייל עַד הַשְּׁטְרוּדֶל, וּלְסִיּוּם הֵקֵש סוּלָמִית'
    }], 'tap', { max_digits: 100, sec_wait: 7, terminate_keys: ['#'] });

    const localPart = decodeEmail(input);
    return await getDomainAndConfirmEmail(call, localPart, 'כתיבה');
}

async function getEmailByVoice(call) {
    const recPath = await call.read([{
        type: 'text',
        data: 'הַקְלֵט אֶת שֵׁם הַמֵּייל שֶׁלְּךָ עַד הַשְּׁטְרוּדֶל, לְאַחַר הַצְּלִיל, וּלְסִיּוּם הֵקֵש סוּלָמִית, שִׂים לֵב יִיתָּכֵן וְהַזִּיהוּי לֹא יִהְיֶה מְדוּיָּק'
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
            await call.id_list_message([{ type: 'text', data: 'לֹא הִצְלַחְנוּ לְזַהוֹת אֶת שֵׁם הַמֵּייל, נַסּוּ שׁוּב' }], { prependToNextAction: true });
            return await getEmailByVoice(call);
        }

        return await getDomainAndConfirmEmail(call, localPart, 'הקלטה');

    } catch (e) {
        console.error('extract email error:', e.message);
        await call.id_list_message([{ type: 'text', data: 'אֵירְעָה שְׁגִיאָה, עוֹבְרִים לְמַצָּב כְּתִיבָה' }], { prependToNextAction: true });
        return await getEmailByKeypad(call);
    }
}

async function getDomainByVoice(call) {
    const recPath = await call.read([{
        type: 'text',
        data: 'הַקְלֵט אֶת סִיּוֹמֶת הַמֵּייל לְאַחַר הַצְּלִיל, וּלְסִיּוּם הֵקֵש סוּלָמִית, לְדוּגְמָה הַקְלֵט יָאהוּ נְקוּדָּה קוֹם'
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
            await call.id_list_message([{ type: 'text', data: 'לֹא הִצְלַחְנוּ לְזַהוֹת אֶת הַסִּיּוֹמֶת, נַסּוּ שׁוּב' }], { prependToNextAction: true });
            return await getDomainByVoice(call);
        }

        const domainSpoken = speakEmail('@' + domain).replace('שטרודל ', '');
        const confirm = await call.read([{
            type: 'text',
            data: `הַסִּיּוֹמֶת שְּׁזוּהֲתָה הִיא ${domainSpoken}, לְאִישׁוּר הֵקֵש 1, לְנִיסָּיוֹן מֵחָדָשׁ הֵקֵש 2`
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
        data: 'לְסִיּוֹמֶת גִּימֵייל נְקוּדָּה קוֹם הֵקֵש 1, לְסִיּוֹמֶת יָאהוּ נְקוּדָּה קוֹם הֵקֵש 2, לְסִיּוֹמֶת וָואלֶה נְקוּדָּה קוֹם הֵקֵש 3, לְסִיּוֹמֶת הוֹטְמֵייל נְקוּדָּה קוֹם הֵקֵש 4, לְסִיּוֹמֶת אַחֶרֶת הֵקֵש 5'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3, 4, 5] });

    const domains = { '1': 'gmail.com', '2': 'yahoo.com', '3': 'walla.com', '4': 'hotmail.com' };

    let domain = '';
    if (domainChoice === '5') {
        if (mode === 'הקלטה') {
            domain = await getDomainByVoice(call);
        } else {
            const domainPart = await call.read([{
                type: 'text',
                data: 'הַקְלֵד אֶת הַסִּיּוֹמֶת, וּלְסִיּוּם הֵקֵש סוּלָמִית'
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
        data: `הַמֵּייל שֶׁהִתְקַבֵּל הוּא ${emailSpoken}, לְאִישׁוּר הֵקֵש 1, לְתִיקּוּן הֵקֵש 2`
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    if (confirm === '1') return email;
    if (mode === 'הקלטה') return await getEmailByVoice(call);
    return await getEmailByKeypad(call);
}

async function getEmail(call) {
    const modeChoice = await call.read([{
        type: 'text',
        data: 'לְמַצָּב הַקְלָטָה הֵקֵש 1, לְמַצָּב כְּתִיבָה הֵקֵש 2'
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
    let welcomeMsg = 'שָׁלוֹם וּבְרוּכִים הַבָּאִים לְמַעֲרֶכֶת הַתַּמְלוּל';
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
        if (customer.is_blocked) {
            await call.id_list_message([
                { type: 'text', data: 'מִצְטַעֲרִים, חֶשְׁבּוֹנְךָ חָסוּם, לְפְרָטִים פְּנֵה לְשֵׁירוּת לְקוּחוֹת' },
                { type: 'go_to_folder', data: 'hangup' }
            ]);
            return;
        }
        if (customer.balance > 0) {
            const balanceShekel = Math.floor(customer.balance);
            const balanceAgorot = Math.round((customer.balance - balanceShekel) * 100);
            if (balanceAgorot > 0) {
                welcomeMsg += `, יִתְרָתְךָ הִיא ${balanceShekel} שֶׁקֶל וְ ${balanceAgorot} אֲגוֹרוֹת`;
            } else {
                welcomeMsg += `, יִתְרָתְךָ הִיא ${balanceShekel} שֶׁקֶל`;
            }
        }
    } catch (e) {
        console.error('customer error:', e.message);
    }

    const ADMIN_PHONE = '0527134491';
    const allowedDigits = phone === ADMIN_PHONE ? [0, 1, 2, 3, 5, 9] : [1, 2, 3, 5, 9];

    const choice = await call.read([{
        type: 'text',
        data: `${welcomeMsg}, לְהַתְחָלַת הַקְלָטָה הֵקֵש 1, לְתַפְרִיט אֶפְשָׁרוּיוֹת הֵקֵש 2, לְהֶסְבֵּר עַל הַמַּעֲרֶכֶת הֵקֵש 3, לִשְׁלִיחַת הַקְלָטָה בְּמֵייל הֵקֵש 5, לְהַשְׁאָרַת הוֹדָעָה לַמְנַהֵל הֵקֵש 9`
    }], 'tap', { max_digits: 1, digits_allowed: allowedDigits });

    if (choice === '1') {
        await handleRecording(call, phone, customer);
    } else if (choice === '3') {
        await call.id_list_message([
            { type: 'text', data: 'מַעֲרֶכֶת זוֹ מְאַפְשֶׁרֶת לְהַקְלִיט הוֹדָעוֹת שֶׁיְּתוּמְלְלוּ וְיִישָּׁלְחוּ אֵלֶיךָ לְמֵייל אוֹ לְפַקְס, שִׂיחָה טוֹבָה' },
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
        'נִיתָּן לִשְׁלוֹחַ הַקְלָטָה לְתַמְלוּל גַּם בְּאֶמְצָעוּת מֵייל, ' +
        'בְּלִי לְהִתְקַשֵּׁר לַמַּעֲרֶכֶת, שׁוֹלְחִים מֵייל עִם קוֹבֶץ הַהַקְלָטָה מְצוֹרָף לְכְתוֹבֶת הַמֵּייל שֶׁל הַמַּעֲרֶכֶת, ' +
        'וּבְשׁוּרַת הַנּוֹשֵׂא שֶׁל הַמֵּייל כּוֹתְבִים אֶת מִסְפַּר הַטֶּלֶפוֹן שֶׁלְּךָ, ' +
        `כְּלוֹמַר ${phoneSpoken}, ` +
        'אֶפְשָׁר גַּם לְצַיֵּן בְּשׁוּרַת הַנּוֹשֵׂא אַחֲרֵי הַמִּסְפָּר אֶת סוּג הַתַּמְלוּל וְאֶת שְׂפַת הַהַקְלָטָה וּשְׂפַת הַפְּלָט הָרְצוּיָה, ' +
        'הַתַּמְלוּל יִישָּׁלַח בַּחֲזָרָה לְאוֹתָהּ כְּתוֹבֶת מֵייל שֶׁמִּמֶּנָּה נִשְׁלְחָה הַהַקְלָטָה, ' +
        'שִׁימּוּשׁ זֶה מִתְאַפְשֵׁר רַק מִכְּתוֹבֶת מֵייל הָרְשׁוּמָה וּמְעוּדְכֶּנֶת בַּמַּעֲרֶכֶת, וּבְתְנַאי שֶׁיֵּשׁ יִתְרָה בָּאַרְנַק';

    if (hasEmail) {
        const choice = await call.read([{
            type: 'text',
            data: `${explainMsg}, לְקַבָּלַת הוֹרָאוֹת מְפוֹרָטוֹת עִם דוּגְמָאוֹת וְקִישׁוּר יָשִׁיר לְמֵייל הֵקֵש 1, לַחֲזָרָה לְתַפְרִיט הָרָאשִׁי הֵקֵש 0`
        }], 'tap', { max_digits: 1, digits_allowed: [0, 1] });

        if (choice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/send-email-instructions`, { phone });
                await call.id_list_message([
                    { type: 'text', data: 'הַהוֹרָאוֹת הַמְּפוֹרָטוֹת נִשְׁלְחוּ לְכְתוֹבֶת הַמֵּייל שֶׁלְּךָ, שִׂיחָה טוֹבָה' },
                    { type: 'go_to_folder', data: '/' }
                ]);
            } catch (e) {
                console.error('send-email-instructions error:', e.message);
                await call.id_list_message([
                    { type: 'text', data: 'אֵירְעָה שְׁגִיאָה בִּשְׁלִיחַת הַהוֹרָאוֹת, שִׂיחָה טוֹבָה' },
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
                data: `${explainMsg}, כְּדֵי לְקַבֵּל הוֹרָאוֹת מְפוֹרָטוֹת בְּמֵייל, יֵשׁ לְעַדְכֵּן קוֹדֶם כְּתוֹבֶת מֵייל בְּתַפְרִיט עִדְכּוּן פְּרָטִים`
            },
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

    const recPath = await call.read([{
        type: 'text',
        data: 'הַשְׁאֵר הוֹדָעָתְךָ לַמְּנַהֵל לְאַחַר הַצְּלִיל, לְסִיּוּם הֵקֵש סוּלָמִית'
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
        { type: 'text', data: 'הוֹדָעָתְךָ הִתְקַבְּלָה, הַמְּנַהֵל יַחְזוֹר אֵלֶיךָ בְּהַקְדֵּם, שִׂיחָה טוֹבָה' },
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleRecording(call, phone, customer) {
    const minBalance = 0;
    if (customer && customer.balance <= minBalance) {
        const choice = await call.read([{
            type: 'text',
            data: 'יִתְרָתְךָ נְמוּכָה, לְמַעֲבָר לִטְעִינַת אַרְנַק הֵקֵש 1, לְהַמְשִׁיךְ בְּלִי תַּשְׁלוּם הֵקֵש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (choice === '1') {
            await call.id_list_message([
                { type: 'text', data: 'לִטְעִינַת אַרְנַק, פְּנֵה לְמְנַהֵל הַמַּעֲרֶכֶת, שִׂיחָה טוֹבָה' },
                { type: 'go_to_folder', data: 'hangup' }
            ]);
            return;
        }
    }

    const tierChoice = await call.read([{
        type: 'text',
        data: 'לְתַמְלוּל רָגִיל הֵקֵש 1, לְתַמְלוּל מִקְצוֹעִי הֵקֵש 2'
    }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

    const transcriptionTier = tierChoice === '2' ? 'premium' : 'gemini';

    let language = 'he';
    let outputLanguage = 'he';
    if (transcriptionTier === 'premium' || transcriptionTier === 'gemini' || transcriptionTier === 'basic') {
        const langChoice = await call.read([{
            type: 'text',
            data: 'לְתַמְלוּל בְּעִבְרִית הֵקֵש 1, בְּיִידִישׁ הֵקֵש 2, בְּאַנְגְלִית הֵקֵש 3'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2, 3] });

        language = langChoice === '2' ? 'yi' : langChoice === '3' ? 'en' : 'he';

        if (language === 'yi') {
            const outChoice = await call.read([{
                type: 'text',
                data: 'לְקַבֵּל אֶת הַתַּמְלוּל בְּיִידִישׁ הֵקֵש 1, בְּעִבְרִית הֵקֵש 2'
            }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            outputLanguage = outChoice === '2' ? 'he' : 'yi';
        } else if (language === 'en') {
            const outChoice = await call.read([{
                type: 'text',
                data: 'לְקַבֵּל אֶת הַתַּמְלוּל בְּאַנְגְלִית הֵקֵש 1, בְּעִבְרִית הֵקֵש 2'
            }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
            outputLanguage = outChoice === '2' ? 'he' : 'en';
        }
    }

    const recPath = await call.read([{
        type: 'text',
        data: 'הַשְׁאֵר אֶת הוֹדָעָתְךָ לְאַחַר הַצְּלִיל, לְסִיּוּם הֵקֵש סוּלָמִית אוֹ נַתֵּק'
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
            data: 'לִשְׁלִיחָה לְמֵייל הֵקֵש 1, לִשְׁלִיחָה לְפַקְס הֵקֵש 2'
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
                data: 'הֵקֵש אֶת מִסְפַּר הַפַּקְס שֶׁלְּךָ, וּלְאַחַר מִכֵּן הֵקֵש סוּלָמִית'
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
        { type: 'text', data: 'הַהַקְלָטָה הִתְקַבְּלָה, הַתַּמְלוּל יִישָּׁלַח אֵלֶיךָ בְּקָרוֹב, שִׂיחָה טוֹבָה' },
        { type: 'go_to_folder', data: '/' }
    ]);
}

async function handleOptions(call, phone) {
    const choice = await call.read([{
        type: 'text',
        data: 'לִטְעִינַת אַרְנַק הֵקֵש 1, לְעִדְכּוּן פְּרָטִים הֵקֵש 2, לַחֲזָרָה הֵקֵש 0'
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2] });

    if (choice === '1') {
        await call.id_list_message([
            { type: 'text', data: 'לִטְעִינַת אַרְנַק, פְּנֵה לְמְנַהֵל הַמַּעֲרֶכֶת, שִׂיחָה טוֹבָה' },
            { type: 'go_to_folder', data: 'hangup' }
        ]);
    } else if (choice === '2') {
        await handleUpdateDetails(call, phone);
    } else {
        await call.id_list_message([
            { type: 'go_to_folder', data: '/' }
        ]);
    }
}

async function handleUpdateDetails(call, phone) {
    let customer = null;
    try {
        const res = await axios.get(`${PYTHON_URL}/api/customer/${phone}`);
        customer = res.data;
    } catch (e) {}

    const emailSpoken = customer && customer.email ? speakEmail(customer.email) : '';
    const emailMsg = emailSpoken ? `הַמֵּייל שֶׁלְּךָ הוּא ${emailSpoken}` : 'לֹא מְעוּדְכֶּן מֵייל';
    const faxMsg = customer && customer.fax ? `הַפַּקְס שֶׁלְּךָ הוּא ${customer.fax}` : 'לֹא מְעוּדְכֶּן פַּקְס';
    const deliveryMsg = customer && customer.delivery_method === 'fax' ? 'שִׁיטַּת הַשְּׁלִיחָה הִיא פַּקְס' : 'שִׁיטַּת הַשְּׁלִיחָה הִיא מֵייל';

    const choice = await call.read([{
        type: 'text',
        data: `${emailMsg}, ${faxMsg}, ${deliveryMsg}, לְעִדְכּוּן מֵייל הֵקֵש 1, לְעִדְכּוּן פַּקְס הֵקֵש 2, לְשִׁינּוּי שִׁיטַּת שְׁלִיחָה הֵקֵש 3, לַחֲזָרָה הֵקֵש 0`
    }], 'tap', { max_digits: 1, digits_allowed: [0, 1, 2, 3] });

    if (choice === '1') {
        const email = await getEmail(call);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, email, delivery_method: 'email' });
        } catch (e) {}
        await call.id_list_message([{ type: 'text', data: 'הַמֵּייל עוּדְכַּן בְּהַצְלָחָה' }], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '2') {
        const fax = await call.read([{
            type: 'text',
            data: 'הֵקֵש אֶת מִסְפַּר הַפַּקְס שֶׁלְּךָ, וּלְאַחַר מִכֵּן הֵקֵש סוּלָמִית'
        }], 'tap', { max_digits: 15, terminate_keys: ['#'] });
        const confirm = await call.read([{
            type: 'text',
            data: `מִסְפַּר הַפַּקְס שֶׁהוּקְלַד הוּא ${fax}, לְאִישׁוּר הֵקֵש 1, לְתִיקּוּן הֵקֵש 2`
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });
        if (confirm === '2') return await handleUpdateDetails(call, phone);
        try {
            await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, fax, delivery_method: 'fax' });
        } catch (e) {}
        await call.id_list_message([{ type: 'text', data: 'הַפַּקְס עוּדְכַּן בְּהַצְלָחָה' }], { prependToNextAction: true });
        return await handleUpdateDetails(call, phone);

    } else if (choice === '3') {
        const methodChoice = await call.read([{
            type: 'text',
            data: 'לִשְׁלִיחָה לְמֵייל הֵקֵש 1, לִשְׁלִיחָה לְפַקְס הֵקֵש 2'
        }], 'tap', { max_digits: 1, digits_allowed: [1, 2] });

        if (methodChoice === '1') {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'email' });
            } catch (e) {}
            await call.id_list_message([{ type: 'text', data: 'שִׁיטַּת הַשְּׁלִיחָה עוּדְכְּנָה לְמֵייל' }], { prependToNextAction: true });
        } else {
            try {
                await axios.post(`${PYTHON_URL}/api/customer/update`, { phone, delivery_method: 'fax' });
            } catch (e) {}
            await call.id_list_message([{ type: 'text', data: 'שִׁיטַּת הַשְּׁלִיחָה עוּדְכְּנָה לְפַקְס' }], { prependToNextAction: true });
        }
        return await handleUpdateDetails(call, phone);

    } else {
        await handleOptions(call, phone);
    }
}

async function handleAdminMessages(call) {
    const msgId = await call.read([{
        type: 'text',
        data: 'הֵקֵש אֶת מִסְפַּר הַהוֹדָעָה, וּלְסִיּוּם הֵקֵש סוּלָמִית'
    }], 'tap', { max_digits: 10, terminate_keys: ['#'] });

    if (!msgId) {
        await call.id_list_message([
            { type: 'text', data: 'לֹא הוּקַשׁ מִסְפָּר, שִׂיחָה טוֹבָה' },
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
                { type: 'text', data: 'שְׁגִיאָה בִּטְעִינַת הַהוֹדָעָה, שִׂיחָה טוֹבָה' },
                { type: 'go_to_folder', data: '/' }
            ]);
        }
        return;
    }

    const again = await call.read([{
        type: 'text',
        data: 'לִשְׁמִיעַת הוֹדָעָה נוֹסֶפֶת הֵקֵש 1, לְסִיּוּם הֵקֵש 2'
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
