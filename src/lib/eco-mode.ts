"use strict";

// Eco mode time slots of the older ET firmware ("EcoModeV1" in
// marcelblijleven/goodwe): four groups of four registers at 47515, 47519,
// 47523 and 47527. ARM firmware 19 and newer adds EcoModeV2 at 47547, which
// the adapter does not write (see ECO_MODE_V2_PROBE).
//
// Layout of one group, eight bytes, big endian:
//   register 0: start hour (high byte), start minute (low byte)
//   register 1: end hour (high byte), end minute (low byte)
//   register 2: power in % of the rated power, signed: negative charges the
//               battery, positive discharges it (-100 to 100)
//   register 3: on/off (high byte, 0x00 off, 0xFF on), weekday bits (low byte,
//               bit 0 Sunday to bit 6 Saturday)
// An unused group reads 30 00 30 00 00 64 00 00: hour 48 marks "no time set".

type EcoField =
  | "StartHour"
  | "StartMinute"
  | "EndHour"
  | "EndMinute"
  | "Power"
  | "Enabled"
  | "Days";

interface EcoSlot {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  power: number;
  // Raw on/off byte. marcelblijleven/goodwe treats every value but 0 as on
  // and writes 0xFF itself.
  onOff: number;
  days: number;
}

const ECO_MODE_GROUP_STARTS = [47515, 47519, 47523, 47527] as const;
const ECO_MODE_GROUP_REGISTERS = 4;
// Hour value of a group the inverter never got a time for.
const ECO_UNSET_HOUR = 48;
const ECO_ON = 0xff;
const ECO_OFF = 0x00;
const ECO_ALL_DAYS = 0x7f;
// marcelblijleven/goodwe reads these six registers to tell EcoModeV2 firmware
// (ARM 19 and newer) from EcoModeV1 firmware, which rejects the address.
const ECO_MODE_V2_PROBE = { start: 47547, count: 6 } as const;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Decodes the eight bytes of one eco mode group.
 *
 * @param bytes register payload of the group, at least eight bytes
 */
function decodeEcoSlot(bytes: Uint8Array): EcoSlot {
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
function encodeEcoSlot(slot: EcoSlot): number[] {
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
function isEcoSlotEnabled(slot: EcoSlot): boolean {
  return slot.onOff !== ECO_OFF;
}

/**
 * Returns a copy of the group with one field replaced.
 *
 * @param slot eco mode group as the inverter holds it
 * @param field field the state stands for
 * @param value register value, already range checked by the control path
 */
function withEcoField(slot: EcoSlot, field: EcoField, value: number): EcoSlot {
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
function validateEcoSlot(slot: EcoSlot): string | null {
  const enabled = isEcoSlotEnabled(slot);
  const validHour = (hour: number): boolean =>
    Number.isInteger(hour) &&
    ((hour >= 0 && hour <= 23) || (!enabled && hour === ECO_UNSET_HOUR));
  const validMinute = (minute: number): boolean =>
    Number.isInteger(minute) && minute >= 0 && minute <= 59;

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
  if (
    !Number.isInteger(slot.days) ||
    slot.days < 0 ||
    (slot.days > ECO_ALL_DAYS && slot.days !== 0xff)
  ) {
    return "days have to be a bit mask of 0-127";
  }

  return null;
}

/**
 * Returns the weekdays of a bit mask as text, for example "Mon,Tue".
 *
 * @param days weekday bits, bit 0 Sunday to bit 6 Saturday
 */
function decodeEcoDays(days: number): string {
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
function describeEcoSlot(slot: EcoSlot): string {
  const time = (hour: number, minute: number): string =>
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const times =
    slot.startHour === ECO_UNSET_HOUR || slot.endHour === ECO_UNSET_HOUR
      ? "no time set"
      : `${time(slot.startHour, slot.startMinute)}-${time(slot.endHour, slot.endMinute)}`;
  const days = decodeEcoDays(slot.days);

  return `${times}, ${days === "" ? "no days" : days}, ${slot.power} %, ${isEcoSlotEnabled(slot) ? "on" : "off"}`;
}

export type { EcoField, EcoSlot };
export {
  decodeEcoDays,
  decodeEcoSlot,
  describeEcoSlot,
  ECO_ALL_DAYS,
  ECO_MODE_GROUP_REGISTERS,
  ECO_MODE_GROUP_STARTS,
  ECO_MODE_V2_PROBE,
  ECO_OFF,
  ECO_ON,
  ECO_UNSET_HOUR,
  encodeEcoSlot,
  isEcoSlotEnabled,
  validateEcoSlot,
  withEcoField,
};
