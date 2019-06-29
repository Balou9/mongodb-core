// 'use strict';

// var retrieveBSON = require('./utils').retrieveBSON;
// var BSON = retrieveBSON();
// var Long = BSON.Long;
// const Buffer = require('safe-buffer').Buffer;

import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
import { encode } from "https://denopkg.com/chiefbiiko/std-encoding/mod.ts";

import { readInt32LE } from "./../utils.ts";

/** Inefficient but hopefully correct string byte counter. */
function byteLength(str: string, inputEncoding: string = "utf8"): number {
  return encode(str, inputEncoding).byteLength;
}

// Incrementing request id
let _requestId: number = 0;

// Wire command operation ids
// var OPCODES = require('../wireprotocol/shared').OPCODES;
// let OPCODES = null // TODO
import {OPCODES } from "./../wireprotocol/shared.ts";

// Query flags
const OPTS_TAILABLE_CURSOR: number = 2;
const OPTS_SLAVE: number = 4;
const OPTS_OPLOG_REPLAY: number = 8;
const OPTS_NO_CURSOR_TIMEOUT: number = 16;
const OPTS_AWAIT_DATA: number = 32;
const OPTS_EXHAUST: number = 64;
const OPTS_PARTIAL: number = 128;

// Response flags
const CURSOR_NOT_FOUND: number = 1;
const QUERY_FAILURE: number = 2;
const SHARD_CONFIG_STALE: number = 4;
const AWAIT_CAPABLE: number = 8;

/**************************************************************
 * QUERY
 **************************************************************/
export interface QueryOptions {
  numberToSkip?: number;
  numberToReturn?: number;
  serializeFunctions?: boolean;
  checkKeys?: boolean;
  slaveOk?: boolean
  maxBSONSize?: number;
  returnFieldSelector?:  {[key:string]:any};
  // pre32Limit?: unknown;
}

/** A class representation of a query. */
export class Query {
  // readonly bson: { serialize: (obj: any, opts: BSON.SerializationOptions) => Uint8Array };
  readonly ns: string;
  readonly query: {[key:string]:any};
    readonly requestId: number;

  numberToSkip:number
  numberToReturn: number
  returnFieldSelector: {[key:string]:any};
  // pre32Limit: unknown;
  serializeFunctions: boolean;
  maxBSONSize: number;
  checkKeys: boolean;
  batchSize: number;

  tailable: boolean;
  slaveOk: boolean;
  oplogReplay: boolean;
  noCursorTimeout: boolean;
  awaitData: boolean;
  exhaust: boolean;
  partial: boolean

  /** Creates a new query. */
  constructor(/*bson: { serialize: (obj: any, opts: BSON.SerializationOptions) => Uint8Array },*/ ns: string, query: {[key:string]: any}, options: QueryOptions = {}) {
   // const self: Query = this;
    // Basic options needed to be passed in
    if (!ns) {throw new Error('ns must be specified for query');}
    if (query === null) {throw new Error('query must be specified for query');}

    // Validate that we are not passing 0x00 in the collection name
    if (ns.indexOf('\x00') !== -1) {
      throw new Error('namespace cannot contain a null character');
    }

    // Basic options
    // this.bson = bson;
    this.ns = ns;
    this.query = query;
    this.requestId = Query.getRequestId();
    
    // Additional options
    this.numberToSkip = options.numberToSkip || 0;
    this.numberToReturn = options.numberToReturn || 0;
    this.returnFieldSelector = options.returnFieldSelector || null;

    // special case for pre-3.2 find commands, delete ASAP
    // this.pre32Limit = options.pre32Limit;

    // Serialization option
    this.serializeFunctions =
      typeof options.serializeFunctions === 'boolean' ? options.serializeFunctions : false;
    // this.ignoreUndefined =
    //   typeof options.ignoreUndefined === 'boolean' ? options.ignoreUndefined : false;
    this.maxBSONSize = options.maxBSONSize || 1024 * 1024 * 16;
    this.checkKeys = typeof options.checkKeys === 'boolean' ? options.checkKeys : true;
    this.batchSize = this.numberToReturn;

    // Flags
    this.tailable = false;
    this.slaveOk = typeof options.slaveOk === 'boolean' ? options.slaveOk : false;
    this.oplogReplay = false;
    this.noCursorTimeout = false;
    this.awaitData = false;
    this.exhaust = false;
    this.partial = false;
  }

  /** Gets the next request id. */
  static nextRequestId(): number {
    return _requestId + 1;
  }

  /** Increments and returns the next request id. */
  static getRequestId(): number {
    return ++_requestId;
  }

  /** Increments this instance's request id. */
  incRequestId(): void {
    this.requestId = _requestId++;
  }

  /**
   * Convert this query to its binary representation.
   * Uses a single allocated buffer for the process.
   */
  toBin (): Uint8Array[] {
    // var self = this;
    const buffers: Uint8Array[]  = [];
    let projection: Uint8Array = null;

    // Set up the flags
    let flags: number = 0;

    if (this.tailable) {
      flags |= OPTS_TAILABLE_CURSOR;
    }

    if (this.slaveOk) {
      flags |= OPTS_SLAVE;
    }

    if (this.oplogReplay) {
      flags |= OPTS_OPLOG_REPLAY;
    }

    if (this.noCursorTimeout) {
      flags |= OPTS_NO_CURSOR_TIMEOUT;
    }

    if (this.awaitData) {
      flags |= OPTS_AWAIT_DATA;
    }

    if (this.exhaust) {
      flags |= OPTS_EXHAUST;
    }

    if (this.partial) {
      flags |= OPTS_PARTIAL;
    }

    // If batchSize is different to self.numberToReturn
    if (this.batchSize !== this.numberToReturn){ this.numberToReturn = this.batchSize;}

    // Allocate write protocol header buffer
    const header: Uint8Array = new Uint8Array(
      4 * 4 + // Header
      4 + // Flags
      byteLength(this.ns) +
      1 + // namespace
      4 + // numberToSkip
        4 // numberToReturn
    );

    // Add header to buffers
    buffers.push(header);

    // Serialize the query
  const query: Uint8Array = BSON.serialize(this.query, {
      checkKeys: this.checkKeys,
      serializeFunctions: this.serializeFunctions
      // ignoreUndefined: this.ignoreUndefined
    });

    // Add query document
    buffers.push(query);

    if (this.returnFieldSelector && Object.keys(this.returnFieldSelector).length > 0) {
      // Serialize the projection document
      projection = BSON.serialize(this.returnFieldSelector, {
        checkKeys: this.checkKeys,
        serializeFunctions: this.serializeFunctions
        // ignoreUndefined: this.ignoreUndefined
      });
      // Add projection document
      buffers.push(projection);
    }

    // Total message size
  const totalLength: number = header.length + query.length + (projection ? projection.length : 0);

    // Set up the index
    let index: number = 4;

    // Write total document length
    header[3] = (totalLength >> 24) & 0xff;
    header[2] = (totalLength >> 16) & 0xff;
    header[1] = (totalLength >> 8) & 0xff;
    header[0] = totalLength & 0xff;

    // Write header information requestId
    header[index + 3] = (this.requestId >> 24) & 0xff;
    header[index + 2] = (this.requestId >> 16) & 0xff;
    header[index + 1] = (this.requestId >> 8) & 0xff;
    header[index] = this.requestId & 0xff;
    index = index + 4;

    // Write header information responseTo
    header[index + 3] = (0 >> 24) & 0xff;
    header[index + 2] = (0 >> 16) & 0xff;
    header[index + 1] = (0 >> 8) & 0xff;
    header[index] = 0 & 0xff;
    index = index + 4;

    // Write header information OP_QUERY
    header[index + 3] = (OPCODES.OP_QUERY >> 24) & 0xff;
    header[index + 2] = (OPCODES.OP_QUERY >> 16) & 0xff;
    header[index + 1] = (OPCODES.OP_QUERY >> 8) & 0xff;
    header[index] = OPCODES.OP_QUERY & 0xff;
    index = index + 4;

    // Write header information flags
    header[index + 3] = (flags >> 24) & 0xff;
    header[index + 2] = (flags >> 16) & 0xff;
    header[index + 1] = (flags >> 8) & 0xff;
    header[index] = flags & 0xff;
    index = index + 4;

    // Write collection name
    // index = index + header.write(this.ns, index, 'utf8') + 1;
    const encodedNs: Uint8Array = encode(this.ns, "utf8");
    header.set(encodedNs, index);
    index = index + encodedNs.byteLength + 1;
    header[index - 1] = 0;

    // Write header information flags numberToSkip
    header[index + 3] = (this.numberToSkip >> 24) & 0xff;
    header[index + 2] = (this.numberToSkip >> 16) & 0xff;
    header[index + 1] = (this.numberToSkip >> 8) & 0xff;
    header[index] = this.numberToSkip & 0xff;
    index = index + 4;

    // Write header information flags numberToReturn
    header[index + 3] = (this.numberToReturn >> 24) & 0xff;
    header[index + 2] = (this.numberToReturn >> 16) & 0xff;
    header[index + 1] = (this.numberToReturn >> 8) & 0xff;
    header[index] = this.numberToReturn & 0xff;
    index = index + 4;

    // Return the buffers
    return buffers;
  }

}

// var Query = function(bson, ns, query, options) {
//   var self = this;
//   // Basic options needed to be passed in
//   if (ns == null) throw new Error('ns must be specified for query');
//   if (query == null) throw new Error('query must be specified for query');
//
//   // Validate that we are not passing 0x00 in the collection name
//   if (ns.indexOf('\x00') !== -1) {
//     throw new Error('namespace cannot contain a null character');
//   }
//
//   // Basic options
//   this.bson = bson;
//   this.ns = ns;
//   this.query = query;
//
//   // Additional options
//   this.numberToSkip = options.numberToSkip || 0;
//   this.numberToReturn = options.numberToReturn || 0;
//   this.returnFieldSelector = options.returnFieldSelector || null;
//   this.requestId = Query.getRequestId();
//
//   // special case for pre-3.2 find commands, delete ASAP
//   this.pre32Limit = options.pre32Limit;
//
//   // Serialization option
//   this.serializeFunctions =
//     typeof options.serializeFunctions === 'boolean' ? options.serializeFunctions : false;
//   this.ignoreUndefined =
//     typeof options.ignoreUndefined === 'boolean' ? options.ignoreUndefined : false;
//   this.maxBSONSize = options.maxBSONSize || 1024 * 1024 * 16;
//   this.checkKeys = typeof options.checkKeys === 'boolean' ? options.checkKeys : true;
//   this.batchSize = self.numberToReturn;
//
//   // Flags
//   this.tailable = false;
//   this.slaveOk = typeof options.slaveOk === 'boolean' ? options.slaveOk : false;
//   this.oplogReplay = false;
//   this.noCursorTimeout = false;
//   this.awaitData = false;
//   this.exhaust = false;
//   this.partial = false;
// };

//
// // Assign a new request Id
// Query.prototype.incRequestId = function() {
//   this.requestId = _requestId++;
// };
//
// //
// // Assign a new request Id
// Query.nextRequestId = function() {
//   return _requestId + 1;
// };

// //
// // Uses a single allocated buffer for the process, avoiding multiple memory allocations
// Query.prototype.toBin = function() {
//   var self = this;
//   var buffers = [];
//   var projection = null;
//
//   // Set up the flags
//   var flags = 0;
//   if (this.tailable) {
//     flags |= OPTS_TAILABLE_CURSOR;
//   }
//
//   if (this.slaveOk) {
//     flags |= OPTS_SLAVE;
//   }
//
//   if (this.oplogReplay) {
//     flags |= OPTS_OPLOG_REPLAY;
//   }
//
//   if (this.noCursorTimeout) {
//     flags |= OPTS_NO_CURSOR_TIMEOUT;
//   }
//
//   if (this.awaitData) {
//     flags |= OPTS_AWAIT_DATA;
//   }
//
//   if (this.exhaust) {
//     flags |= OPTS_EXHAUST;
//   }
//
//   if (this.partial) {
//     flags |= OPTS_PARTIAL;
//   }
//
//   // If batchSize is different to self.numberToReturn
//   if (self.batchSize !== self.numberToReturn) self.numberToReturn = self.batchSize;
//
//   // Allocate write protocol header buffer
//   var header = Buffer.alloc(
//     4 * 4 + // Header
//     4 + // Flags
//     Buffer.byteLength(self.ns) +
//     1 + // namespace
//     4 + // numberToSkip
//       4 // numberToReturn
//   );
//
//   // Add header to buffers
//   buffers.push(header);
//
//   // Serialize the query
//   var query = self.bson.serialize(this.query, {
//     checkKeys: this.checkKeys,
//     serializeFunctions: this.serializeFunctions,
//     ignoreUndefined: this.ignoreUndefined
//   });
//
//   // Add query document
//   buffers.push(query);
//
//   if (self.returnFieldSelector && Object.keys(self.returnFieldSelector).length > 0) {
//     // Serialize the projection document
//     projection = self.bson.serialize(this.returnFieldSelector, {
//       checkKeys: this.checkKeys,
//       serializeFunctions: this.serializeFunctions,
//       ignoreUndefined: this.ignoreUndefined
//     });
//     // Add projection document
//     buffers.push(projection);
//   }
//
//   // Total message size
//   var totalLength = header.length + query.length + (projection ? projection.length : 0);
//
//   // Set up the index
//   var index = 4;
//
//   // Write total document length
//   header[3] = (totalLength >> 24) & 0xff;
//   header[2] = (totalLength >> 16) & 0xff;
//   header[1] = (totalLength >> 8) & 0xff;
//   header[0] = totalLength & 0xff;
//
//   // Write header information requestId
//   header[index + 3] = (this.requestId >> 24) & 0xff;
//   header[index + 2] = (this.requestId >> 16) & 0xff;
//   header[index + 1] = (this.requestId >> 8) & 0xff;
//   header[index] = this.requestId & 0xff;
//   index = index + 4;
//
//   // Write header information responseTo
//   header[index + 3] = (0 >> 24) & 0xff;
//   header[index + 2] = (0 >> 16) & 0xff;
//   header[index + 1] = (0 >> 8) & 0xff;
//   header[index] = 0 & 0xff;
//   index = index + 4;
//
//   // Write header information OP_QUERY
//   header[index + 3] = (OPCODES.OP_QUERY >> 24) & 0xff;
//   header[index + 2] = (OPCODES.OP_QUERY >> 16) & 0xff;
//   header[index + 1] = (OPCODES.OP_QUERY >> 8) & 0xff;
//   header[index] = OPCODES.OP_QUERY & 0xff;
//   index = index + 4;
//
//   // Write header information flags
//   header[index + 3] = (flags >> 24) & 0xff;
//   header[index + 2] = (flags >> 16) & 0xff;
//   header[index + 1] = (flags >> 8) & 0xff;
//   header[index] = flags & 0xff;
//   index = index + 4;
//
//   // Write collection name
//   index = index + header.write(this.ns, index, 'utf8') + 1;
//   header[index - 1] = 0;
//
//   // Write header information flags numberToSkip
//   header[index + 3] = (this.numberToSkip >> 24) & 0xff;
//   header[index + 2] = (this.numberToSkip >> 16) & 0xff;
//   header[index + 1] = (this.numberToSkip >> 8) & 0xff;
//   header[index] = this.numberToSkip & 0xff;
//   index = index + 4;
//
//   // Write header information flags numberToReturn
//   header[index + 3] = (this.numberToReturn >> 24) & 0xff;
//   header[index + 2] = (this.numberToReturn >> 16) & 0xff;
//   header[index + 1] = (this.numberToReturn >> 8) & 0xff;
//   header[index] = this.numberToReturn & 0xff;
//   index = index + 4;
//
//   // Return the buffers
//   return buffers;
// };

// Query.getRequestId = function() {
//   return ++_requestId;
// };

/**************************************************************
 * GETMORE
 **************************************************************/
export interface GetMoreOptions {
   numberToReturn?: number;
 }

export class GetMore {
  // readonly bson: { serialize: (obj: any, opts: BSON.SerializationOptions) => Uint8Array };
  readonly ns: string;
  readonly cursorId: BSON.Long

  numberToReturn: number;
  requestId: number;

  /** Creates a GetMore instance. */
  constructor(/*bson: { serialize: (obj: any, opts: BSON.SerializationOptions) => Uint8Array },*/ ns: string, cursorId: BSON.Long, options: GetMoreOptions = {}) {
    // this.bson = bson;
    this.ns = ns;
    this.cursorId = cursorId;
    this.numberToReturn = options.numberToReturn || 0;
    this.requestId = _requestId++;
  }

  /**
   * Convert this query to its binary representation.
   * Uses a single allocated buffer for the process.
   */
  toBin() {
    // Create command buffer
    const length: number = 4 + byteLength(this.ns) + 1 + 4 + 8 + 4 * 4;
    const buf: Uint8Array = new Uint8Array(length);
    let index: number = 0;

    // Write header information
    // index = write32bit(index, buf, length);
    buf[index + 3] = (length >> 24) & 0xff;
    buf[index + 2] = (length >> 16) & 0xff;
    buf[index + 1] = (length >> 8) & 0xff;
    buf[index] = length & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, requestId);
    buf[index + 3] = (this.requestId >> 24) & 0xff;
    buf[index + 2] = (this.requestId >> 16) & 0xff;
    buf[index + 1] = (this.requestId >> 8) & 0xff;
    buf[index] = this.requestId & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, 0);
    buf[index + 3] = (0 >> 24) & 0xff;
    buf[index + 2] = (0 >> 16) & 0xff;
    buf[index + 1] = (0 >> 8) & 0xff;
    buf[index] = 0 & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, OP_GETMORE);
    buf[index + 3] = (OPCODES.OP_GETMORE >> 24) & 0xff;
    buf[index + 2] = (OPCODES.OP_GETMORE >> 16) & 0xff;
    buf[index + 1] = (OPCODES.OP_GETMORE >> 8) & 0xff;
    buf[index] = OPCODES.OP_GETMORE & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, 0);
    buf[index + 3] = (0 >> 24) & 0xff;
    buf[index + 2] = (0 >> 16) & 0xff;
    buf[index + 1] = (0 >> 8) & 0xff;
    buf[index] = 0 & 0xff;
    index = index + 4;

    // Write collection name
    // index = index + buf.write(this.ns, index, 'utf8') + 1;
    const encodedNs: Uint8Array = encode(this.ns, "utf8");
    buf.set(encodedNs, index);
    index = index + encodedNs.byteLength + 1;
    buf[index - 1] = 0;

    // Write batch size
    // index = write32bit(index, buf, numberToReturn);
    buf[index + 3] = (this.numberToReturn >> 24) & 0xff;
    buf[index + 2] = (this.numberToReturn >> 16) & 0xff;
    buf[index + 1] = (this.numberToReturn >> 8) & 0xff;
    buf[index] = this.numberToReturn & 0xff;
    index = index + 4;

    // Write cursor id
    // index = write32bit(index, buf, cursorId.getLowBits());
    buf[index + 3] = (this.cursorId.getLowBits() >> 24) & 0xff;
    buf[index + 2] = (this.cursorId.getLowBits() >> 16) & 0xff;
    buf[index + 1] = (this.cursorId.getLowBits() >> 8) & 0xff;
    buf[index] = this.cursorId.getLowBits() & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, cursorId.getHighBits());
    buf[index + 3] = (this.cursorId.getHighBits() >> 24) & 0xff;
    buf[index + 2] = (this.cursorId.getHighBits() >> 16) & 0xff;
    buf[index + 1] = (this.cursorId.getHighBits() >> 8) & 0xff;
    buf[index] = this.cursorId.getHighBits() & 0xff;
    index = index + 4;

    // Return buffer
    return buf;
  }
}

// var GetMore = function(bson, ns, cursorId, opts) {
//   opts = opts || {};
//   this.numberToReturn = opts.numberToReturn || 0;
//   this.requestId = _requestId++;
//   this.bson = bson;
//   this.ns = ns;
//   this.cursorId = cursorId;
// };

//
// Uses a single allocated buffer for the process, avoiding multiple memory allocations
// GetMore.prototype.toBin = function() {
//   var length = 4 + Buffer.byteLength(this.ns) + 1 + 4 + 8 + 4 * 4;
//   // Create command buffer
//   var index = 0;
//   // Allocate buffer
//   var _buffer = Buffer.alloc(length);
//
//   // Write header information
//   // index = write32bit(index, _buffer, length);
//   _buffer[index + 3] = (length >> 24) & 0xff;
//   _buffer[index + 2] = (length >> 16) & 0xff;
//   _buffer[index + 1] = (length >> 8) & 0xff;
//   _buffer[index] = length & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, requestId);
//   _buffer[index + 3] = (this.requestId >> 24) & 0xff;
//   _buffer[index + 2] = (this.requestId >> 16) & 0xff;
//   _buffer[index + 1] = (this.requestId >> 8) & 0xff;
//   _buffer[index] = this.requestId & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, 0);
//   _buffer[index + 3] = (0 >> 24) & 0xff;
//   _buffer[index + 2] = (0 >> 16) & 0xff;
//   _buffer[index + 1] = (0 >> 8) & 0xff;
//   _buffer[index] = 0 & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, OP_GETMORE);
//   _buffer[index + 3] = (OPCODES.OP_GETMORE >> 24) & 0xff;
//   _buffer[index + 2] = (OPCODES.OP_GETMORE >> 16) & 0xff;
//   _buffer[index + 1] = (OPCODES.OP_GETMORE >> 8) & 0xff;
//   _buffer[index] = OPCODES.OP_GETMORE & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, 0);
//   _buffer[index + 3] = (0 >> 24) & 0xff;
//   _buffer[index + 2] = (0 >> 16) & 0xff;
//   _buffer[index + 1] = (0 >> 8) & 0xff;
//   _buffer[index] = 0 & 0xff;
//   index = index + 4;
//
//   // Write collection name
//   index = index + _buffer.write(this.ns, index, 'utf8') + 1;
//   _buffer[index - 1] = 0;
//
//   // Write batch size
//   // index = write32bit(index, _buffer, numberToReturn);
//   _buffer[index + 3] = (this.numberToReturn >> 24) & 0xff;
//   _buffer[index + 2] = (this.numberToReturn >> 16) & 0xff;
//   _buffer[index + 1] = (this.numberToReturn >> 8) & 0xff;
//   _buffer[index] = this.numberToReturn & 0xff;
//   index = index + 4;
//
//   // Write cursor id
//   // index = write32bit(index, _buffer, cursorId.getLowBits());
//   _buffer[index + 3] = (this.cursorId.getLowBits() >> 24) & 0xff;
//   _buffer[index + 2] = (this.cursorId.getLowBits() >> 16) & 0xff;
//   _buffer[index + 1] = (this.cursorId.getLowBits() >> 8) & 0xff;
//   _buffer[index] = this.cursorId.getLowBits() & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, cursorId.getHighBits());
//   _buffer[index + 3] = (this.cursorId.getHighBits() >> 24) & 0xff;
//   _buffer[index + 2] = (this.cursorId.getHighBits() >> 16) & 0xff;
//   _buffer[index + 1] = (this.cursorId.getHighBits() >> 8) & 0xff;
//   _buffer[index] = this.cursorId.getHighBits() & 0xff;
//   index = index + 4;
//
//   // Return buffer
//   return _buffer;
// };

/**************************************************************
 * KILLCURSOR
 **************************************************************/
export class KillCursor {
  // readonly bson: { serialize: (obj: any, opts: BSON.SerializationOptions) => Uint8Array };
  readonly ns: string;
  readonly cursorIds: BSON.Long[]

  requestId: number;

  /** Creates a new KillCursor instance. */
  constructor(/*bson: any,*/ ns: string, cursorIds: BSON.Long[]) {
    this.ns = ns
    this.requestId = _requestId++;
    this.cursorIds = cursorIds;
  }

  /**
   * Convert this query to its binary representation.
   * Uses a single allocated buffer for the process.
   */
  toBin() {
    // Create command buffer
    const length: number = 4 + 4 + 4 * 4 + this.cursorIds.length * 8;
    const buf: Uint8Array = new Uint8Array(length);
    let index: number = 0;

    // Write header information
    // index = write32bit(index, _buffer, length);
    buf[index + 3] = (length >> 24) & 0xff;
    buf[index + 2] = (length >> 16) & 0xff;
    buf[index + 1] = (length >> 8) & 0xff;
    buf[index] = length & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, requestId);
    buf[index + 3] = (this.requestId >> 24) & 0xff;
    buf[index + 2] = (this.requestId >> 16) & 0xff;
    buf[index + 1] = (this.requestId >> 8) & 0xff;
    buf[index] = this.requestId & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, 0);
    buf[index + 3] = (0 >> 24) & 0xff;
    buf[index + 2] = (0 >> 16) & 0xff;
    buf[index + 1] = (0 >> 8) & 0xff;
    buf[index] = 0 & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, OP_KILL_CURSORS);
    buf[index + 3] = (OPCODES.OP_KILL_CURSORS >> 24) & 0xff;
    buf[index + 2] = (OPCODES.OP_KILL_CURSORS >> 16) & 0xff;
    buf[index + 1] = (OPCODES.OP_KILL_CURSORS >> 8) & 0xff;
    buf[index] = OPCODES.OP_KILL_CURSORS & 0xff;
    index = index + 4;

    // index = write32bit(index, buf, 0);
    buf[index + 3] = (0 >> 24) & 0xff;
    buf[index + 2] = (0 >> 16) & 0xff;
    buf[index + 1] = (0 >> 8) & 0xff;
    buf[index] = 0 & 0xff;
    index = index + 4;

    // Write batch size
    // index = write32bit(index, buf, this.cursorIds.length);
    buf[index + 3] = (this.cursorIds.length >> 24) & 0xff;
    buf[index + 2] = (this.cursorIds.length >> 16) & 0xff;
    buf[index + 1] = (this.cursorIds.length >> 8) & 0xff;
    buf[index] = this.cursorIds.length & 0xff;
    index = index + 4;

    // Write all the cursor ids into the array
    for (let i: number = 0; i < this.cursorIds.length; i++) {
      // Write cursor id
      // index = write32bit(index, buf, cursorIds[i].getLowBits());
      buf[index + 3] = (this.cursorIds[i].getLowBits() >> 24) & 0xff;
      buf[index + 2] = (this.cursorIds[i].getLowBits() >> 16) & 0xff;
      buf[index + 1] = (this.cursorIds[i].getLowBits() >> 8) & 0xff;
      buf[index] = this.cursorIds[i].getLowBits() & 0xff;
      index = index + 4;

      // index = write32bit(index, buf, cursorIds[i].getHighBits());
      buf[index + 3] = (this.cursorIds[i].getHighBits() >> 24) & 0xff;
      buf[index + 2] = (this.cursorIds[i].getHighBits() >> 16) & 0xff;
      buf[index + 1] = (this.cursorIds[i].getHighBits() >> 8) & 0xff;
      buf[index] = this.cursorIds[i].getHighBits() & 0xff;
      index = index + 4;
    }

    // Return buffer
    return buf;
  }
}

// var KillCursor = function(bson, ns, cursorIds) {
//   this.ns = ns;
//   this.requestId = _requestId++;
//   this.cursorIds = cursorIds;
// };

//
// Uses a single allocated buffer for the process, avoiding multiple memory allocations
// KillCursor.prototype.toBin = function() {
//   var length = 4 + 4 + 4 * 4 + this.cursorIds.length * 8;
//
//   // Create command buffer
//   var index = 0;
//   var _buffer = Buffer.alloc(length);
//
//   // Write header information
//   // index = write32bit(index, _buffer, length);
//   _buffer[index + 3] = (length >> 24) & 0xff;
//   _buffer[index + 2] = (length >> 16) & 0xff;
//   _buffer[index + 1] = (length >> 8) & 0xff;
//   _buffer[index] = length & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, requestId);
//   _buffer[index + 3] = (this.requestId >> 24) & 0xff;
//   _buffer[index + 2] = (this.requestId >> 16) & 0xff;
//   _buffer[index + 1] = (this.requestId >> 8) & 0xff;
//   _buffer[index] = this.requestId & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, 0);
//   _buffer[index + 3] = (0 >> 24) & 0xff;
//   _buffer[index + 2] = (0 >> 16) & 0xff;
//   _buffer[index + 1] = (0 >> 8) & 0xff;
//   _buffer[index] = 0 & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, OP_KILL_CURSORS);
//   _buffer[index + 3] = (OPCODES.OP_KILL_CURSORS >> 24) & 0xff;
//   _buffer[index + 2] = (OPCODES.OP_KILL_CURSORS >> 16) & 0xff;
//   _buffer[index + 1] = (OPCODES.OP_KILL_CURSORS >> 8) & 0xff;
//   _buffer[index] = OPCODES.OP_KILL_CURSORS & 0xff;
//   index = index + 4;
//
//   // index = write32bit(index, _buffer, 0);
//   _buffer[index + 3] = (0 >> 24) & 0xff;
//   _buffer[index + 2] = (0 >> 16) & 0xff;
//   _buffer[index + 1] = (0 >> 8) & 0xff;
//   _buffer[index] = 0 & 0xff;
//   index = index + 4;
//
//   // Write batch size
//   // index = write32bit(index, _buffer, this.cursorIds.length);
//   _buffer[index + 3] = (this.cursorIds.length >> 24) & 0xff;
//   _buffer[index + 2] = (this.cursorIds.length >> 16) & 0xff;
//   _buffer[index + 1] = (this.cursorIds.length >> 8) & 0xff;
//   _buffer[index] = this.cursorIds.length & 0xff;
//   index = index + 4;
//
//   // Write all the cursor ids into the array
//   for (var i = 0; i < this.cursorIds.length; i++) {
//     // Write cursor id
//     // index = write32bit(index, _buffer, cursorIds[i].getLowBits());
//     _buffer[index + 3] = (this.cursorIds[i].getLowBits() >> 24) & 0xff;
//     _buffer[index + 2] = (this.cursorIds[i].getLowBits() >> 16) & 0xff;
//     _buffer[index + 1] = (this.cursorIds[i].getLowBits() >> 8) & 0xff;
//     _buffer[index] = this.cursorIds[i].getLowBits() & 0xff;
//     index = index + 4;
//
//     // index = write32bit(index, _buffer, cursorIds[i].getHighBits());
//     _buffer[index + 3] = (this.cursorIds[i].getHighBits() >> 24) & 0xff;
//     _buffer[index + 2] = (this.cursorIds[i].getHighBits() >> 16) & 0xff;
//     _buffer[index + 1] = (this.cursorIds[i].getHighBits() >> 8) & 0xff;
//     _buffer[index] = this.cursorIds[i].getHighBits() & 0xff;
//     index = index + 4;
//   }
//
//   // Return buffer
//   return buf;
// };

export interface ResponseOptions {
  promoteValues?: boolean;
}

export interface ResponseParseOptions {
  raw?: boolean;
    promoteValues?: boolean;
  documentsReturnedIn?: number | string ;
}

export class Response {
  // readonly bson: { deserialize: (bson: Uint8Array, opts: BSON.DeserializationOptions) => Uint8Array };

  raw: unknown;
  data: Uint8Array;
  options: ResponseOptions;
  parsed: boolean;
  length: number;
  requestId: number;
  responseTo: unknown;
  opCode: number;
  fromCompressed: unknown;

  responseFlags: number;
  cursorId: BSON.Long;
  startingFrom: number
  numberReturned: number;

  documents: any[]

  cursorNotFound: boolean;
  queryFailure: boolean;
  shardConfigStale: boolean;
  awaitCapable: boolean;
  promoteValues: boolean;

  index: number;

  /** Creates a response. */
  constructor(/*bson: { deserialize: (bson: Uint8Array, opts: BSON.DeserializationOptions) => any},*/ message: unknown, msgHeader: { [key:string]:any}, msgBody: Uint8Array, options: ResponseOptions = { promoteValues: true}) {
    // opts = opts || { promoteLongs: true, promoteValues: true, promoteBuffers: false };
    // this.bson = bson;
    this.raw = message;
    this.data = msgBody;
    this.options = options;
    this.parsed = false;

    // Read the message header
    this.length = msgHeader.length;
    this.requestId = msgHeader.requestId;
    this.responseTo = msgHeader.responseTo;
    this.opCode = msgHeader.opCode;
    this.fromCompressed = msgHeader.fromCompressed;

    // Read the message body
    this.responseFlags = readInt32LE(msgBody, 0);
    this.cursorId = new BSON.Long(readInt32LE(msgBody, 4), readInt32LE(msgBody, 8));
    this.startingFrom = readInt32LE(msgBody, 12);
    this.numberReturned = readInt32LE(msgBody, 16);

    // Preallocate document array
    this.documents = new Array(this.numberReturned);

    // Flag values
    this.cursorNotFound = (this.responseFlags & CURSOR_NOT_FOUND) !== 0;
    this.queryFailure = (this.responseFlags & QUERY_FAILURE) !== 0;
    this.shardConfigStale = (this.responseFlags & SHARD_CONFIG_STALE) !== 0;
    this.awaitCapable = (this.responseFlags & AWAIT_CAPABLE) !== 0;
    // this.promoteLongs = typeof opts.promoteLongs === 'boolean' ? opts.promoteLongs : true;
    this.promoteValues = typeof options.promoteValues === 'boolean' ? options.promoteValues : true;
    // this.promoteBuffers = typeof opts.promoteBuffers === 'boolean' ? opts.promoteBuffers : false;
  }

  /** Whether the response is parsed. */
  isParsed() {
    return this.parsed;
  }

  /** Parses the response. */
  parse(options: ResponseParseOptions = {}): void {
    // Don't parse again if not needed
    if (this.parsed){ return;}
    // options = options || {};

    // Allow the return of raw documents instead of parsing
    const raw: boolean = options.raw || false;
    const documentsReturnedIn: number | string = options.documentsReturnedIn || null;
    // var promoteLongs =
    //   typeof options.promoteLongs === 'boolean' ? options.promoteLongs : this.opts.promoteLongs;
    const promoteValues: boolean =
      typeof options.promoteValues === 'boolean' ? options.promoteValues : this.options.promoteValues;
    // var promoteBuffers =
    //   typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : this.opts.promoteBuffers;
    let bsonSize: number;
    // let _options;

    // Set up the options
    const _options: BSON.DeserializationOptions = {
      // promoteLongs: promoteLongs,
      promoteValues: promoteValues
      // promoteBuffers: promoteBuffers
    };

    // Position within OP_REPLY at which documents start
    // (See https://docs.mongodb.com/manual/reference/mongodb-wire-protocol/#wire-op-reply)
    this.index = 20;

    // Parse Body
    for (let i: number = 0; i < this.numberReturned; i++) {
      bsonSize =
        this.data[this.index] |
        (this.data[this.index + 1] << 8) |
        (this.data[this.index + 2] << 16) |
        (this.data[this.index + 3] << 24);

      // If we have raw results specified slice the return document
      if (raw) {
        this.documents[i] = this.data.slice(this.index, this.index + bsonSize);
      } else {
        this.documents[i] = BSON.deserialize(
          this.data.slice(this.index, this.index + bsonSize),
          _options
        );
      }

      // Adjust the index
      this.index += bsonSize;
    }

    if (this.documents.length === 1 && documentsReturnedIn != null && raw) {
      const fieldsAsRaw: { [key:string]: any} = {};
      fieldsAsRaw[documentsReturnedIn] = true;
      _options.fieldsAsRaw = fieldsAsRaw;

      const doc: { [key:string]: any} = BSON.deserialize(this.documents[0], _options);
      this.documents = [doc];
    }

    // Set parsed
    this.parsed = true;
  }
}

// var Response = function(bson, message, msgHeader, msgBody, opts) {
//   opts = opts || { promoteLongs: true, promoteValues: true, promoteBuffers: false };
//   this.parsed = false;
//   this.raw = message;
//   this.data = msgBody;
//   this.bson = bson;
//   this.opts = opts;
//
//   // Read the message header
//   this.length = msgHeader.length;
//   this.requestId = msgHeader.requestId;
//   this.responseTo = msgHeader.responseTo;
//   this.opCode = msgHeader.opCode;
//   this.fromCompressed = msgHeader.fromCompressed;
//
//   // Read the message body
//   this.responseFlags = msgBody.readInt32LE(0);
//   this.cursorId = new Long(msgBody.readInt32LE(4), msgBody.readInt32LE(8));
//   this.startingFrom = msgBody.readInt32LE(12);
//   this.numberReturned = msgBody.readInt32LE(16);
//
//   // Preallocate document array
//   this.documents = new Array(this.numberReturned);
//
//   // Flag values
//   this.cursorNotFound = (this.responseFlags & CURSOR_NOT_FOUND) !== 0;
//   this.queryFailure = (this.responseFlags & QUERY_FAILURE) !== 0;
//   this.shardConfigStale = (this.responseFlags & SHARD_CONFIG_STALE) !== 0;
//   this.awaitCapable = (this.responseFlags & AWAIT_CAPABLE) !== 0;
//   this.promoteLongs = typeof opts.promoteLongs === 'boolean' ? opts.promoteLongs : true;
//   this.promoteValues = typeof opts.promoteValues === 'boolean' ? opts.promoteValues : true;
//   this.promoteBuffers = typeof opts.promoteBuffers === 'boolean' ? opts.promoteBuffers : false;
// };

// Response.prototype.isParsed = function() {
//   return this.parsed;
// };

// Response.prototype.parse = function(options) {
//   // Don't parse again if not needed
//   if (this.parsed) return;
//   options = options || {};
//
//   // Allow the return of raw documents instead of parsing
//   var raw = options.raw || false;
//   var documentsReturnedIn = options.documentsReturnedIn || null;
//   var promoteLongs =
//     typeof options.promoteLongs === 'boolean' ? options.promoteLongs : this.opts.promoteLongs;
//   var promoteValues =
//     typeof options.promoteValues === 'boolean' ? options.promoteValues : this.opts.promoteValues;
//   var promoteBuffers =
//     typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : this.opts.promoteBuffers;
//   var bsonSize, _options;
//
//   // Set up the options
//   _options = {
//     promoteLongs: promoteLongs,
//     promoteValues: promoteValues,
//     promoteBuffers: promoteBuffers
//   };
//
//   // Position within OP_REPLY at which documents start
//   // (See https://docs.mongodb.com/manual/reference/mongodb-wire-protocol/#wire-op-reply)
//   this.index = 20;
//
//   //
//   // Parse Body
//   //
//   for (var i = 0; i < this.numberReturned; i++) {
//     bsonSize =
//       this.data[this.index] |
//       (this.data[this.index + 1] << 8) |
//       (this.data[this.index + 2] << 16) |
//       (this.data[this.index + 3] << 24);
//
//     // If we have raw results specified slice the return document
//     if (raw) {
//       this.documents[i] = this.data.slice(this.index, this.index + bsonSize);
//     } else {
//       this.documents[i] = this.bson.deserialize(
//         this.data.slice(this.index, this.index + bsonSize),
//         _options
//       );
//     }
//
//     // Adjust the index
//     this.index = this.index + bsonSize;
//   }
//
//   if (this.documents.length === 1 && documentsReturnedIn != null && raw) {
//     const fieldsAsRaw = {};
//     fieldsAsRaw[documentsReturnedIn] = true;
//     _options.fieldsAsRaw = fieldsAsRaw;
//
//     const doc = this.bson.deserialize(this.documents[0], _options);
//     this.documents = [doc];
//   }
//
//   // Set parsed
//   this.parsed = true;
// };

// module.exports = {
//   Query: Query,
//   GetMore: GetMore,
//   Response: Response,
//   KillCursor: KillCursor
// };
