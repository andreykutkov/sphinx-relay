"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const lndService = require("../grpc");
const lightning_1 = require("../utils/lightning");
const controllers_1 = require("../controllers");
const tribes = require("../utils/tribes");
const lightning_2 = require("../utils/lightning");
const models_1 = require("../models");
const send_1 = require("./send");
const modify_1 = require("./modify");
const msg_1 = require("../utils/msg");
const constants = require(path.join(__dirname, '../../config/constants.json'));
const msgtypes = constants.message_types;
const typesToForward = [
    msgtypes.message, msgtypes.group_join, msgtypes.group_leave, msgtypes.attachment
];
const typesToModify = [
    msgtypes.attachment
];
function onReceive(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("=>>> onReceive", payload);
        // if tribe, owner must forward to MQTT
        let doAction = true;
        const toAddIn = {};
        const isTribe = payload.chat && payload.chat.type === constants.chat_types.tribe;
        if (isTribe && typesToForward.includes(payload.type)) {
            const tribeOwnerPubKey = yield tribes.verifySignedTimestamp(payload.chat.uuid);
            const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
            if (owner.publicKey === tribeOwnerPubKey) {
                // CHECK PRICES
                toAddIn.isTribeOwner = true;
                const chat = yield models_1.models.Chat.findOne({ where: { uuid: payload.chat.uuid } });
                if (payload.type === msgtypes.group_join) {
                    if (payload.message.amount < chat.priceToJoin)
                        doAction = false;
                }
                if (payload.type === msgtypes.message) {
                    if (payload.message.amount < chat.pricePerMessage)
                        doAction = false;
                }
                if (doAction)
                    forwardMessageToTribe(payload);
                else
                    console.log('=> insufficient payment for this action');
            }
        }
        if (doAction)
            doTheAction(Object.assign(Object.assign({}, payload), toAddIn));
    });
}
function doTheAction(data) {
    return __awaiter(this, void 0, void 0, function* () {
        let payload = data;
        if (payload.isTribeOwner) {
            // decrypt and re-encrypt with self pubkey
            const chat = yield models_1.models.Chat.findOne({ where: { uuid: payload.chat.uuid } });
            const pld = yield msg_1.decryptMessage(data, chat);
            const me = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
            payload = yield msg_1.encryptTribeBroadcast(pld, me, true); // true=isTribeOwner
        }
        if (ACTIONS[payload.type]) {
            ACTIONS[payload.type](payload);
        }
        else {
            console.log('Incorrect payload type:', payload.type);
        }
    });
}
function forwardMessageToTribe(ogpayload) {
    return __awaiter(this, void 0, void 0, function* () {
        const chat = yield models_1.models.Chat.findOne({ where: { uuid: ogpayload.chat.uuid } });
        let payload;
        if (typesToModify.includes(ogpayload.type)) {
            payload = yield modify_1.modifyPayload(ogpayload, chat);
        }
        else {
            payload = ogpayload;
        }
        //console.log("FORWARD TO TRIBE",payload) // filter out the sender?
        //const sender = await models.Contact.findOne({where:{publicKey:payload.sender.pub_key}})
        const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
        const type = payload.type;
        const message = payload.message;
        // HERE: NEED TO MAKE SURE ALIAS IS UNIQUE
        // ASK xref TABLE and put alias there too?
        send_1.sendMessage({
            sender: Object.assign(Object.assign({}, owner.dataValues), payload.sender && payload.sender.alias && { alias: payload.sender.alias }),
            chat, type, message,
            skipPubKey: payload.sender.pub_key,
            success: () => { },
            receive: () => { }
        });
    });
}
const ACTIONS = {
    [msgtypes.contact_key]: controllers_1.controllers.contacts.receiveContactKey,
    [msgtypes.contact_key_confirmation]: controllers_1.controllers.contacts.receiveConfirmContactKey,
    [msgtypes.message]: controllers_1.controllers.messages.receiveMessage,
    [msgtypes.invoice]: controllers_1.controllers.invoices.receiveInvoice,
    [msgtypes.direct_payment]: controllers_1.controllers.payments.receivePayment,
    [msgtypes.confirmation]: controllers_1.controllers.confirmations.receiveConfirmation,
    [msgtypes.attachment]: controllers_1.controllers.media.receiveAttachment,
    [msgtypes.purchase]: controllers_1.controllers.media.receivePurchase,
    [msgtypes.purchase_accept]: controllers_1.controllers.media.receivePurchaseAccept,
    [msgtypes.purchase_deny]: controllers_1.controllers.media.receivePurchaseDeny,
    [msgtypes.group_create]: controllers_1.controllers.chats.receiveGroupCreateOrInvite,
    [msgtypes.group_invite]: controllers_1.controllers.chats.receiveGroupCreateOrInvite,
    [msgtypes.group_join]: controllers_1.controllers.chats.receiveGroupJoin,
    [msgtypes.group_leave]: controllers_1.controllers.chats.receiveGroupLeave,
};
function initGrpcSubscriptions() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield lightning_1.getInfo();
            yield lndService.subscribeInvoices(parseKeysendInvoice);
        }
        catch (e) {
            throw e;
        }
    });
}
exports.initGrpcSubscriptions = initGrpcSubscriptions;
function initTribesSubscriptions() {
    return __awaiter(this, void 0, void 0, function* () {
        tribes.connect((topic, message) => __awaiter(this, void 0, void 0, function* () {
            try {
                const msg = message.toString();
                console.log("=====> msg received! TOPIC", topic, "MESSAGE", msg);
                // check topic is signed by sender?
                const payload = yield parseAndVerifyPayload(msg);
                onReceive(payload);
            }
            catch (e) { }
        }));
    });
}
exports.initTribesSubscriptions = initTribesSubscriptions;
// VERIFY PUBKEY OF SENDER from sig
function parseAndVerifyPayload(data) {
    return __awaiter(this, void 0, void 0, function* () {
        let payload;
        const li = data.lastIndexOf('}');
        const msg = data.substring(0, li + 1);
        const sig = data.substring(li + 1);
        try {
            payload = JSON.parse(msg);
            if (payload) {
                const v = yield lightning_2.verifyAscii(msg, sig);
                if (v && v.valid && v.pubkey) {
                    payload.sender = payload.sender || {};
                    payload.sender.pub_key = v.pubkey;
                    return payload;
                }
            }
        }
        catch (e) {
            return null;
        }
    });
}
function parseKeysendInvoice(i) {
    return __awaiter(this, void 0, void 0, function* () {
        const recs = i.htlcs && i.htlcs[0] && i.htlcs[0].custom_records;
        const buf = recs && recs[lightning_2.SPHINX_CUSTOM_RECORD_KEY];
        const data = buf && buf.toString();
        const value = i && i.value && parseInt(i.value);
        if (!data)
            return;
        let payload;
        if (data[0] === '{') {
            try {
                payload = yield parseAndVerifyPayload(data);
            }
            catch (e) { }
        }
        else {
            const threads = weave(data);
            if (threads)
                payload = yield parseAndVerifyPayload(threads);
        }
        if (payload) {
            const dat = payload;
            if (value && dat && dat.message) {
                dat.message.amount = value; // ADD IN TRUE VALUE
            }
            onReceive(dat);
        }
    });
}
exports.parseKeysendInvoice = parseKeysendInvoice;
const chunks = {};
function weave(p) {
    const pa = p.split('_');
    if (pa.length < 4)
        return;
    const ts = pa[0];
    const i = pa[1];
    const n = pa[2];
    const m = pa.filter((u, i) => i > 2).join('_');
    chunks[ts] = chunks[ts] ? [...chunks[ts], { i, n, m }] : [{ i, n, m }];
    if (chunks[ts].length === parseInt(n)) {
        // got em all!
        const all = chunks[ts];
        let payload = '';
        all.slice().sort((a, b) => a.i - b.i).forEach(obj => {
            payload += obj.m;
        });
        delete chunks[ts];
        return payload;
    }
}
//# sourceMappingURL=receive.js.map