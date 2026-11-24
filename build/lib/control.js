"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyControlWrite = applyControlWrite;
exports.clampWriteValue = clampWriteValue;
exports.stripNamespace = stripNamespace;
exports.writableStateIds = writableStateIds;
const register_map_1 = require("./register-map");
const eco_mode_1 = require("./eco-mode");
// Read like the poll reads this group: a lost answer must neither take the
// connection offline nor pause the group the writable states live in.
const controlReadOptions = { optional: true, backoff: false };
/**
 * Returns the ioBroker state ids the control path accepts writes for.
 */
function writableStateIds() {
    return Array.from(register_map_1.writableEntries.keys());
}
/**
 * Strips the adapter namespace from a state id.
 *
 * @param id full state id, for example "goodwe.0.Settings.EmsMode"
 * @param namespace adapter namespace, for example "goodwe.0"
 */
function stripNamespace(id, namespace) {
    return id.startsWith(`${namespace}.`) ? id.slice(namespace.length + 1) : id;
}
/**
 * Converts a state value into register units, before rounding.
 *
 * @param entry register entry
 * @param value numeric state value
 */
function toRegisterUnits(entry, value) {
    const shown = entry.complement === undefined ? value : entry.complement - value;
    return shown * entry.scale;
}
/**
 * Converts a written state value into a register value inside the safe range.
 *
 * The range of a writable entry is in register units, so the state value is
 * converted first. Returns null for values that cannot be sent at all, so the
 * caller can refuse the write instead of guessing a register value for it.
 *
 * Values of an enum register are never clamped: clamping 99 into a mode
 * register would silently switch the inverter to the highest mode it knows
 * instead of refusing an obviously wrong value.
 *
 * @param entry writable register entry
 * @param value value written to the state
 */
function clampWriteValue(entry, value) {
    const range = entry.writable;
    if (!range) {
        return null;
    }
    let numeric = value;
    // Input fields hand numbers over as text. Only plain decimals count: Number()
    // would also turn an empty field into 0 and "0x4" into a mode.
    if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
        numeric = Number(value);
    }
    // A boolean belongs on an on/off register. On a limit true would mean 1 W,
    // on the EMS mode it would pick "Auto".
    if (typeof value === "boolean" && range.min === 0 && range.max === 1) {
        numeric = Number(value);
    }
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        return null;
    }
    const scaled = toRegisterUnits(entry, numeric);
    const register = Math.round(scaled);
    if (range.values) {
        return Number.isInteger(scaled) && range.values.includes(register)
            ? register
            : null;
    }
    // An enum register accepts exactly the values it defines: rounding 4.4 into
    // mode 4 would guess, and clamping 99 would pick the highest mode instead.
    if (entry.states) {
        return Number.isInteger(scaled) &&
            register in entry.states &&
            register >= range.min &&
            register <= range.max
            ? register
            : null;
    }
    // A clamped or rounded value would be a different setting here, for example
    // hour 23 for a typed 25 in an eco mode time slot.
    if (range.strict) {
        return Number.isInteger(scaled) &&
            scaled >= range.min &&
            scaled <= range.max
            ? scaled
            : null;
    }
    return Math.min(range.max, Math.max(range.min, register));
}
/**
 * Reads the register group of a state and writes what the inverter holds.
 *
 * Returns false when the state has no group or the read failed.
 *
 * @param context adapter, inverter and state manager
 * @param stateId state id without the adapter namespace
 */
async function readBack(context, stateId) {
    const groupName = (0, register_map_1.registerGroupOfState)(stateId);
    if (groupName === "" ||
        !(await context.inverter.ReadGroup(groupName, controlReadOptions))) {
        return false;
    }
    await context.states.UpdateStatesFromRegisterMap(register_map_1.registerGroups[groupName]);
    return true;
}
/**
 * Sends one acknowledged state write to the inverter.
 *
 * Only whitelisted registers are written, and only with a value inside the
 * range of the register map. After the write the register group is read back,
 * so the states show what the inverter really stored.
 *
 * @param context adapter, inverter and state manager
 * @param context.adapter adapter instance, used for logging and the namespace
 * @param context.inverter connected inverter
 * @param context.states state manager
 * @param id changed state id
 * @param state changed state
 */
async function applyControlWrite(context, id, state) {
    if (!state || state.ack) {
        return;
    }
    const stateId = stripNamespace(id, context.adapter.namespace);
    const entry = register_map_1.writableEntries.get(stateId);
    if (!entry) {
        return;
    }
    if (!context.states.IsControlEnabled()) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: inverter control is disabled`);
        return;
    }
    await context.states.RunControlWrite(() => sendControlWrite(context, stateId, entry, state.val));
}
/**
 * Checks a control write and sends it to the inverter.
 *
 * @param context adapter, inverter and state manager
 * @param stateId state id without the adapter namespace
 * @param entry writable register entry of the state
 * @param stateValue value written to the state
 */
async function sendControlWrite(context, stateId, entry, stateValue) {
    // Every request would only run into its timeout and hold up the queue, the
    // reconnect probe included. The first poll after the reconnect puts the value
    // the inverter holds back on the state.
    if (!context.inverter.Status) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: inverter is offline`);
        return;
    }
    const value = clampWriteValue(entry, stateValue);
    if (value === null) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: ${String(stateValue)} is not a value this register accepts`);
        // Otherwise the refused value stays on the state, unacknowledged, until the
        // next poll of the group - a whole pollCycle, which can be an hour.
        await readBack(context, stateId);
        return;
    }
    if (entry.ecoSlot) {
        await sendEcoSlotWrite(context, stateId, entry, entry.ecoSlot, value);
        return;
    }
    const shown = (0, register_map_1.toStateValue)(entry, value);
    if (value !== Math.round(toRegisterUnits(entry, Number(stateValue)))) {
        context.adapter.log.warn(`Clamped write to ${stateId} from ${String(stateValue)} to ${shown}`);
    }
    const groupName = (0, register_map_1.registerGroupOfState)(stateId);
    // Scripts tend to repeat the same setpoint every cycle, and GoodWe does not
    // say whether these registers end up in flash. Reading the group first costs
    // one small request and spares every write that would change nothing. The
    // last poll is no substitute: it can be a whole pollCycle old, and the GoodWe
    // app changes these registers as well.
    if (groupName !== "" &&
        (await context.inverter.ReadGroup(groupName, controlReadOptions)) &&
        context.states.RegisterValue(register_map_1.registerGroups[groupName], entry) === shown) {
        context.adapter.log.debug(`Skipping write to ${stateId}: inverter already holds ${shown}`);
        await context.states.UpdateStatesFromRegisterMap(register_map_1.registerGroups[groupName]);
        return;
    }
    const written = await context.inverter.WriteRegister(entry.address, value);
    // The adapter unloaded while the write waited in the queue: nothing was sent
    // and nothing is left to read back or to warn about.
    if (context.inverter.Closed) {
        return;
    }
    if (written) {
        context.adapter.log.info(`Wrote ${shown} to ${stateId}`);
    }
    else {
        context.adapter.log.warn(`Inverter did not confirm write to ${stateId}`);
    }
    // Read back either way: a rejected write leaves the state showing a value the
    // inverter never stored.
    if (await readBack(context, stateId)) {
        return;
    }
    // Without a read-back the state would stay unacknowledged forever, showing a
    // value nobody confirmed. Acknowledge what the inverter echoed; a failed
    // write keeps its warning and is corrected by the next poll of the group.
    if (written) {
        await context.states.Acknowledge(stateId, shown);
    }
}
/**
 * Writes one field of an eco mode time slot as part of its whole group.
 *
 * The group is read fresh from the inverter, the field replaced, the whole
 * group checked and then sent in one multiple register write (0x10), the way
 * marcelblijleven/goodwe writes it. A group that cannot be read, or that would
 * be invalid after the change, is not written at all.
 *
 * @param context adapter, inverter and state manager
 * @param stateId state id without the adapter namespace
 * @param entry writable eco mode entry
 * @param ecoSlot group start and field of the entry
 * @param value register value, already range checked
 */
async function sendEcoSlotWrite(context, stateId, entry, ecoSlot, value) {
    const { start, field } = ecoSlot;
    // Firmware with EcoModeV2 (ARM 19 and newer) keeps its slots elsewhere;
    // writing the old registers there would change something nobody looks at,
    // or something else entirely. marcelblijleven/goodwe tells them apart the
    // same way: EcoModeV1 firmware rejects this read.
    if ((await context.inverter.ReadRegisters(eco_mode_1.ECO_MODE_V2_PROBE.start, eco_mode_1.ECO_MODE_V2_PROBE.count)) !== null) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: the inverter has the newer eco mode registers (47547 ff.), which this adapter does not write`);
        await readBack(context, stateId);
        return;
    }
    const bytes = await context.inverter.ReadRegisters(start, eco_mode_1.ECO_MODE_GROUP_REGISTERS);
    if (context.inverter.Closed) {
        return;
    }
    if (bytes === null) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: could not read eco mode group ${start}, nothing written`);
        await readBack(context, stateId);
        return;
    }
    const current = (0, eco_mode_1.decodeEcoSlot)(bytes);
    const next = (0, eco_mode_1.withEcoField)(current, field, value);
    const problem = (0, eco_mode_1.validateEcoSlot)(next);
    if (problem !== null) {
        context.adapter.log.warn(`Ignoring write to ${stateId}: ${problem} (group would be ${(0, eco_mode_1.describeEcoSlot)(next)})`);
        await readBack(context, stateId);
        return;
    }
    const registers = (0, eco_mode_1.encodeEcoSlot)(next);
    if ((0, eco_mode_1.encodeEcoSlot)(current).every((register, i) => register === registers[i])) {
        context.adapter.log.debug(`Skipping write to ${stateId}: inverter already holds ${(0, eco_mode_1.describeEcoSlot)(current)}`);
        await readBack(context, stateId);
        return;
    }
    const written = await context.inverter.WriteRegisters(start, registers);
    if (context.inverter.Closed) {
        return;
    }
    const shown = (0, register_map_1.toStateValue)(entry, value);
    if (written) {
        context.adapter.log.info(`Wrote ${shown} to ${stateId} (eco mode group ${start}: ${(0, eco_mode_1.describeEcoSlot)(next)})`);
    }
    else {
        context.adapter.log.warn(`Inverter did not confirm write to ${stateId}`);
    }
    if (await readBack(context, stateId)) {
        return;
    }
    if (written) {
        await context.states.Acknowledge(stateId, shown);
    }
}
