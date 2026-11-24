"use strict";

import {
  registerGroupOfState,
  registerGroups,
  toStateValue,
  writableEntries,
} from "./register-map";
import type { RegisterEntry } from "./register-map";
import {
  decodeEcoSlot,
  describeEcoSlot,
  ECO_MODE_GROUP_REGISTERS,
  ECO_MODE_V2_PROBE,
  encodeEcoSlot,
  validateEcoSlot,
  withEcoField,
} from "./eco-mode";

interface ControlInverter {
  Status: boolean;
  Closed: boolean;
  WriteRegister: (address: number, value: number) => Promise<boolean>;
  WriteRegisters: (start: number, values: number[]) => Promise<boolean>;
  ReadRegisters: (start: number, count: number) => Promise<Uint8Array | null>;
  ReadGroup: (
    groupName: string,
    options?: { optional?: boolean; backoff?: boolean },
  ) => Promise<boolean>;
}

// Read like the poll reads this group: a lost answer must neither take the
// connection offline nor pause the group the writable states live in.
const controlReadOptions = { optional: true, backoff: false };

interface ControlStates {
  IsControlEnabled: () => boolean;
  RunControlWrite: (write: () => Promise<void>) => Promise<void>;
  UpdateStatesFromRegisterMap: (
    group: (typeof registerGroups)[string],
  ) => Promise<void>;
  Acknowledge: (id: string, value: ioBroker.StateValue) => Promise<void>;
  RegisterValue: (
    group: (typeof registerGroups)[string],
    item: RegisterEntry,
  ) => ioBroker.StateValue;
}

interface ControlAdapter {
  log: ioBroker.Logger;
  namespace: string;
}

interface ControlContext {
  adapter: ControlAdapter;
  inverter: ControlInverter;
  states: ControlStates;
}

/**
 * Returns the ioBroker state ids the control path accepts writes for.
 */
function writableStateIds(): string[] {
  return Array.from(writableEntries.keys());
}

/**
 * Strips the adapter namespace from a state id.
 *
 * @param id full state id, for example "goodwe.0.Settings.EmsMode"
 * @param namespace adapter namespace, for example "goodwe.0"
 */
function stripNamespace(id: string, namespace: string): string {
  return id.startsWith(`${namespace}.`) ? id.slice(namespace.length + 1) : id;
}

/**
 * Converts a state value into register units, before rounding.
 *
 * @param entry register entry
 * @param value numeric state value
 */
function toRegisterUnits(entry: RegisterEntry, value: number): number {
  const shown =
    entry.complement === undefined ? value : entry.complement - value;
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
function clampWriteValue(
  entry: RegisterEntry,
  value: ioBroker.StateValue,
): number | null {
  const range = entry.writable;

  if (!range) {
    return null;
  }

  let numeric: unknown = value;

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
async function readBack(
  context: ControlContext,
  stateId: string,
): Promise<boolean> {
  const groupName = registerGroupOfState(stateId);

  if (
    groupName === "" ||
    !(await context.inverter.ReadGroup(groupName, controlReadOptions))
  ) {
    return false;
  }

  await context.states.UpdateStatesFromRegisterMap(registerGroups[groupName]);
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
async function applyControlWrite(
  context: ControlContext,
  id: string,
  state: ioBroker.State | null | undefined,
): Promise<void> {
  if (!state || state.ack) {
    return;
  }

  const stateId = stripNamespace(id, context.adapter.namespace);
  const entry = writableEntries.get(stateId);

  if (!entry) {
    return;
  }

  if (!context.states.IsControlEnabled()) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: inverter control is disabled`,
    );
    return;
  }

  await context.states.RunControlWrite(() =>
    sendControlWrite(context, stateId, entry, state.val),
  );
}

/**
 * Checks a control write and sends it to the inverter.
 *
 * @param context adapter, inverter and state manager
 * @param stateId state id without the adapter namespace
 * @param entry writable register entry of the state
 * @param stateValue value written to the state
 */
async function sendControlWrite(
  context: ControlContext,
  stateId: string,
  entry: RegisterEntry,
  stateValue: ioBroker.StateValue,
): Promise<void> {
  // Every request would only run into its timeout and hold up the queue, the
  // reconnect probe included. The first poll after the reconnect puts the value
  // the inverter holds back on the state.
  if (!context.inverter.Status) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: inverter is offline`,
    );
    return;
  }

  const value = clampWriteValue(entry, stateValue);

  if (value === null) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: ${String(stateValue)} is not a value this register accepts`,
    );
    // Otherwise the refused value stays on the state, unacknowledged, until the
    // next poll of the group - a whole pollCycle, which can be an hour.
    await readBack(context, stateId);
    return;
  }

  if (entry.ecoSlot) {
    await sendEcoSlotWrite(context, stateId, entry, entry.ecoSlot, value);
    return;
  }

  const shown = toStateValue(entry, value);

  if (value !== Math.round(toRegisterUnits(entry, Number(stateValue)))) {
    context.adapter.log.warn(
      `Clamped write to ${stateId} from ${String(stateValue)} to ${shown}`,
    );
  }

  const groupName = registerGroupOfState(stateId);

  // Scripts tend to repeat the same setpoint every cycle, and GoodWe does not
  // say whether these registers end up in flash. Reading the group first costs
  // one small request and spares every write that would change nothing. The
  // last poll is no substitute: it can be a whole pollCycle old, and the GoodWe
  // app changes these registers as well.
  if (
    groupName !== "" &&
    (await context.inverter.ReadGroup(groupName, controlReadOptions)) &&
    context.states.RegisterValue(registerGroups[groupName], entry) === shown
  ) {
    context.adapter.log.debug(
      `Skipping write to ${stateId}: inverter already holds ${shown}`,
    );
    await context.states.UpdateStatesFromRegisterMap(registerGroups[groupName]);
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
  } else {
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
async function sendEcoSlotWrite(
  context: ControlContext,
  stateId: string,
  entry: RegisterEntry,
  ecoSlot: NonNullable<RegisterEntry["ecoSlot"]>,
  value: number,
): Promise<void> {
  const { start, field } = ecoSlot;

  // Firmware with EcoModeV2 (ARM 19 and newer) keeps its slots elsewhere;
  // writing the old registers there would change something nobody looks at,
  // or something else entirely. marcelblijleven/goodwe tells them apart the
  // same way: EcoModeV1 firmware rejects this read.
  if (
    (await context.inverter.ReadRegisters(
      ECO_MODE_V2_PROBE.start,
      ECO_MODE_V2_PROBE.count,
    )) !== null
  ) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: the inverter has the newer eco mode registers (47547 ff.), which this adapter does not write`,
    );
    await readBack(context, stateId);
    return;
  }

  const bytes = await context.inverter.ReadRegisters(
    start,
    ECO_MODE_GROUP_REGISTERS,
  );

  if (context.inverter.Closed) {
    return;
  }

  if (bytes === null) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: could not read eco mode group ${start}, nothing written`,
    );
    await readBack(context, stateId);
    return;
  }

  const current = decodeEcoSlot(bytes);
  const next = withEcoField(current, field, value);
  const problem = validateEcoSlot(next);

  if (problem !== null) {
    context.adapter.log.warn(
      `Ignoring write to ${stateId}: ${problem} (group would be ${describeEcoSlot(next)})`,
    );
    await readBack(context, stateId);
    return;
  }

  const registers = encodeEcoSlot(next);

  if (
    encodeEcoSlot(current).every((register, i) => register === registers[i])
  ) {
    context.adapter.log.debug(
      `Skipping write to ${stateId}: inverter already holds ${describeEcoSlot(current)}`,
    );
    await readBack(context, stateId);
    return;
  }

  const written = await context.inverter.WriteRegisters(start, registers);

  if (context.inverter.Closed) {
    return;
  }

  const shown = toStateValue(entry, value);

  if (written) {
    context.adapter.log.info(
      `Wrote ${shown} to ${stateId} (eco mode group ${start}: ${describeEcoSlot(next)})`,
    );
  } else {
    context.adapter.log.warn(`Inverter did not confirm write to ${stateId}`);
  }

  if (await readBack(context, stateId)) {
    return;
  }

  if (written) {
    await context.states.Acknowledge(stateId, shown);
  }
}

export type { ControlAdapter, ControlInverter, ControlStates };
export { applyControlWrite, clampWriteValue, stripNamespace, writableStateIds };
