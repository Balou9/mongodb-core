// 'use strict';
// 
// const crypto = require('crypto');
// const requireOptional = require('require_optional');

/** Generic representation of a node-style callback. */
export type Callback = (err?:any, data?:any, ...rest: any[]) => any;

/** Noop function. */
export function noop(): void {}

/** Reads an unsigned byte from the buffer at given offset. */
export function readUint8(buf: Uint8Array, offset: number = 0): number {
  return buf[offset] & 0xff;
}

/** Reads a signed int from four little endian bytes starting at offset. */
export function readInt32LE(buf: Uint8Array, offset: number = 0): number {
  return buf[offset] | buf[offset + 1] << 8 | buf[offset + 2] << 16 | buf[offset + 3] << 24
}

/** Reads an unsigned int from four little endian bytes starting at offset. */
export function readUint32LE(buf: Uint8Array, offset: number = 0): number {
  return buf[offset] & 0xff | (buf[offset + 1] << 8) & 0xff | (buf[offset + 2] << 16) & 0xff | (buf[offset + 3] << 24)  & 0xff
}

/** Writes an unsigned int to four little endian bytes starting at offset. */
export function writeUint32LE(buf: Uint8Array,int: number, offset: number = 0): number {
  // return buf[offset] | buf[offset + 1] << 8 | buf[offset + 2] << 16 | buf[offset + 3] << 24
  buf[offset] = int & 0xff
  buf[offset + 1] = int >> 8 & 0xff;
  buf[offset + 2] = int >> 16 & 0xff
  buf[offset + 3] = int >> 24 & 0xff
  
  return buf.byteLength - offset;
}

/** Writes a signed int to four little endian bytes starting at offset. */
export function writeInt32LE(buf: Uint8Array,int: number, offset: number = 0): number {
  // return buf[offset] | buf[offset + 1] << 8 | buf[offset + 2] << 16 | buf[offset + 3] << 24
  buf[offset] = int
  buf[offset + 1] = int >> 8
  buf[offset + 2] = int >> 16 
  buf[offset + 3] = int >> 24 
  
  return buf.byteLength - offset;
}

/** Gernerates a UUID v4. */
export function uuidv4(): Uint8Array {
  const r: Uint8Array = crypto.getRandomValues(new Uint8Array(16));
  
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  
  return r;
}

// /**
//  * Generate a UUIDv4
//  */
// const uuidV4 = () => {
//   const result = crypto.randomBytes(16);
//   result[6] = (result[6] & 0x0f) | 0x40;
//   result[8] = (result[8] & 0x3f) | 0x80;
//   return result;
// };

/** Calculates a ms duration from a simple timestamp (Date.now). */
export function calculateDurationInMs(started: number): number {
  return Date.now() - started;
}

// /**
//  * Returns the duration calculated from two high resolution timers in milliseconds
//  *
//  * @param {Object} started A high resolution timestamp created from `process.hrtime()`
//  * @returns {Number} The duration in milliseconds
//  */
// const calculateDurationInMs = started => {
//   const hrtime = process.hrtime(started);
//   return (hrtime[0] * 1e9 + hrtime[1]) / 1e6;
// };

/** Relays events for a given source and target emitter. */
export function relayEvents(source: EventEmitter, target: EventEmitter, events: string[]): void {
  events.forEach((eventName: string): void => source.on(eventName, (...args: any[]): void => target.emit(eventName, ...args)));
}

// /**
//  * Relays events for a given listener and emitter
//  *
//  * @param {EventEmitter} listener the EventEmitter to listen to the events from
//  * @param {EventEmitter} emitter the EventEmitter to relay the events to
//  */
// function relayEvents(listener, emitter, events) {
//   events.forEach(eventName => listener.on(eventName, event => emitter.emit(eventName, event)));
// }

// function retrieveKerberos() {
//   let kerberos;
// 
//   try {
//     kerberos = requireOptional('kerberos');
//   } catch (err) {
//     if (err.code === 'MODULE_NOT_FOUND') {
//       throw new Error('The `kerberos` module was not found. Please install it and try again.');
//     }
// 
//     throw err;
//   }
// 
//   return kerberos;
// }

// // Throw an error if an attempt to use EJSON is made when it is not installed
// const noEJSONError = function() {
//   throw new Error('The `mongodb-extjson` module was not found. Please install it and try again.');
// };

// // Facilitate loading EJSON optionally
// function retrieveEJSON() {
//   let EJSON = null;
//   try {
//     EJSON = requireOptional('mongodb-extjson');
//   } catch (error) {} // eslint-disable-line
//   if (!EJSON) {
//     EJSON = {
//       parse: noEJSONError,
//       deserialize: noEJSONError,
//       serialize: noEJSONError,
//       stringify: noEJSONError,
//       setBSONModule: noEJSONError,
//       BSON: noEJSONError
//     };
//   }
// 
//   return EJSON;
// }

/**
 * A helper function for determining `maxWireVersion` between legacy and new topology
 * instances.
 */
export function maxWireVersion(topologyOrServer: any): number {
  if (topologyOrServer.ismaster) {
    return topologyOrServer.ismaster.maxWireVersion;
  }

  if (topologyOrServer.description) {
    return topologyOrServer.description.maxWireVersion;
  }

  return null;
}

/* Checks that collation is supported by server. */
export function collationNotSupported(server: any, cmd: {[key: string]: any}): boolean {
  return cmd && cmd.collation && maxWireVersion(server) < 5;
}

// /**
//  * Checks if a given value is a Promise
//  *
//  * @param {*} maybePromise
//  * @return true if the provided value is a Promise
//  */
// function isPromiseLike(maybePromise) {
//   return maybePromise && typeof maybePromise.then === 'function';
// }

// module.exports = {
//   uuidV4,
//   calculateDurationInMs,
//   relayEvents,
//   collationNotSupported,
//   retrieveEJSON,
//   retrieveKerberos,
//   maxWireVersion,
//   isPromiseLike
// };
