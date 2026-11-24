"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ECO_UNSET_HOUR = exports.ECO_ON = exports.ECO_OFF = exports.ECO_MODE_V2_PROBE = exports.ECO_MODE_GROUP_STARTS = exports.ECO_MODE_GROUP_REGISTERS = exports.ECO_ALL_DAYS = void 0;
exports.decodeEcoDays = decodeEcoDays;
exports.decodeEcoSlot = decodeEcoSlot;
exports.describeEcoSlot = describeEcoSlot;
exports.encodeEcoSlot = encodeEcoSlot;
exports.isEcoSlotEnabled = isEcoSlotEnabled;
exports.validateEcoSlot = validateEcoSlot;
exports.withEcoField = withEcoField;
const ECO_MODE_GROUP_STARTS = [47515, 47519, 47523, 47527];
exports.ECO_MODE_GROUP_STARTS = ECO_MODE_GROUP_STARTS;
const ECO_MODE_GROUP_REGISTERS = 4;
exports.ECO_MODE_GROUP_REGISTERS = ECO_MODE_GROUP_REGISTERS;
// Hour value of a group the inverter never got a time for.
const ECO_UNSET_HOUR = 48;
exports.ECO_UNSET_HOUR = ECO_UNSET_HOUR;
const ECO_ON = 0xff;
exports.ECO_ON = ECO_ON;
const ECO_OFF = 0x00;
exports.ECO_OFF = ECO_OFF;
const ECO_ALL_DAYS = 0x7f;
exports.ECO_ALL_DAYS = ECO_ALL_DAYS;
// marcelblijleven/goodwe reads these six registers to tell EcoModeV2 firmware
// (ARM 19 and newer) from EcoModeV1 firmware, which rejects the address.
const ECO_MODE_V2_PROBE = { start: 47547, count: 6 };
exports.ECO_MODE_V2_PROBE = ECO_MODE_V2_PROBE;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/**
 * Decodes the eight bytes of one eco mode group.
 *
 * @param bytes register payload of the group, at least eight bytes
 */
function decodeEcoSlot(bytes) {
    if (bytes.length < ECO_MODE_GROUP_REGISTERS * 2) {
        throw new Error(`Eco mode group needs 8 bytes, got ${bytes.length}`);
    }
    const power = (bytes[4] << 8) | bytes[5];
    return {
        startHour: bytes[0],
        startMinute: bytes[1],
        endHour: bytes[2],
        endMinute: bytes[3],
        power: power >= 0x8000 ? power - 0x10000 : power,
        onOff: bytes[6],
        days: bytes[7],
    };
}
/**
 * Encodes one eco mode group into its four register values (unsigned 16 bit).
 *
 * @param slot eco mode group, checked with validateEcoSlot() before
 */
function encodeEcoSlot(slot) {
    return [
        ((slot.startHour & 0xff) << 8) | (slot.startMinute & 0xff),
        ((slot.endHour & 0xff) << 8) | (slot.endMinute & 0xff),
        slot.power & 0xffff,
        ((slot.onOff & 0xff) << 8) | (slot.days & 0xff),
    ];
}
/**
 * Reports whether the group switch is on.
 *
 * @param slot eco mode group
 */
function isEcoSlotEnabled(slot) {
    return slot.onOff !== ECO_OFF;
}
/**
 * Returns a copy of the group with one field replaced.
 *
 * @param slot eco mode group as the inverter holds it
 * @param field field the state stands for
 * @param value register value, already range checked by the control path
 */
function withEcoField(slot, field, value) {
    const next = { ...slot };
    switch (field) {
        case "StartHour":
            next.startHour = value;
            break;
        case "StartMinute":
            next.startMinute = value;
            break;
        case "EndHour":
            next.endHour = value;
            break;
        case "EndMinute":
            next.endMinute = value;
            break;
        case "Power":
            next.power = value;
            break;
        case "Enabled":
            next.onOff = value === 0 ? ECO_OFF : ECO_ON;
            break;
        case "Days":
            next.days = value;
            break;
    }
    return next;
}
/**
 * Checks a whole eco mode group before it is written.
 *
 * Returns the reason a group must not be sent, or null when it is fine. The
 * unset hour 48 the inverter uses for an unused group is kept as long as the
 * group stays off, so the fields of an unused group can be filled in one by
 * one; switching it on needs real times.
 *
 * @param slot eco mode group about to be written
 */
function validateEcoSlot(slot) {
    const enabled = isEcoSlotEnabled(slot);
    const validHour = (hour) => Number.isInteger(hour) &&
        ((hour >= 0 && hour <= 23) || (!enabled && hour === ECO_UNSET_HOUR));
    const validMinute = (minute) => Number.isInteger(minute) && minute >= 0 && minute <= 59;
    if (!validHour(slot.startHour) || !validHour(slot.endHour)) {
        return enabled &&
            (slot.startHour === ECO_UNSET_HOUR || slot.endHour === ECO_UNSET_HOUR)
            ? "start and end time have to be set before the group is switched on"
            : "hours have to be 0-23";
    }
    if (!validMinute(slot.startMinute) || !validMinute(slot.endMinute)) {
        return "minutes have to be 0-59";
    }
    if (!Number.isInteger(slot.power) || slot.power < -100 || slot.power > 100) {
        return "power has to be -100 to 100 %";
    }
    // Anything but 0x00 and 0xFF can only come from the inverter itself, the
    // Enabled state writes 0xFF or 0x00. Kept as it is when another field changes.
    if (!Number.isInteger(slot.onOff) || slot.onOff < 0 || slot.onOff > 0xff) {
        return "invalid on/off value";
    }
    // 0xFF is how some firmware reports "every day"; it is kept, never written
    // from a state (the Days state accepts 0-127).
    if (!Number.isInteger(slot.days) ||
        slot.days < 0 ||
        (slot.days > ECO_ALL_DAYS && slot.days !== 0xff)) {
        return "days have to be a bit mask of 0-127";
    }
    return null;
}
/**
 * Returns the weekdays of a bit mask as text, for example "Mon,Tue".
 *
 * @param days weekday bits, bit 0 Sunday to bit 6 Saturday
 */
function decodeEcoDays(days) {
    if ((days & ECO_ALL_DAYS) === ECO_ALL_DAYS) {
        return "Mon-Sun";
    }
    return DAY_NAMES.filter((_, bit) => (days & (1 << bit)) !== 0).join(",");
}
/**
 * Returns a short human readable summary of one group.
 *
 * @param slot eco mode group
 */
function describeEcoSlot(slot) {
    const time = (hour, minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const times = slot.startHour === ECO_UNSET_HOUR || slot.endHour === ECO_UNSET_HOUR
        ? "no time set"
        : `${time(slot.startHour, slot.startMinute)}-${time(slot.endHour, slot.endMinute)}`;
    const days = decodeEcoDays(slot.days);
    return `${times}, ${days === "" ? "no days" : days}, ${slot.power} %, ${isEcoSlotEnabled(slot) ? "on" : "off"}`;
}
