'use strict';

// Implementation of OP_MSG spec:
// https://github.com/mongodb/specifications/blob/master/source/message/OP_MSG.rst
//
// struct Section {
//   uint8 payloadType;
//   union payload {
//       document  document; // payloadType == 0
//       struct sequence { // payloadType == 1
//           int32      size;
//           cstring    identifier;
//           document*  documents;
//       };
//   };
// };

// struct OP_MSG {
//   struct MsgHeader {
//       int32  messageLength;
//       int32  requestID;
//       int32  responseTo;
//       int32  opCode = 2013;
//   };
//   uint32      flagBits;
//   Section+    sections;
//   [uint32     checksum;]
// };

import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const opcodes = require('../wireprotocol/shared').opcodes;
import { OPCODES, databaseNamespace } from "./../wireprotocol/shared.ts";
// const databaseNamespace = require('../wireprotocol/shared').databaseNamespace;
// const ReadPreference = require('../topologies/read_preference');
import { ReadPreference } from "./../topologies/read_preference.ts";
import {MongoError} from "./../errors.ts";
import { writeInt32LE, writeUint32LE} from "./../utils.ts"

// Incrementing request id
let _requestId: number = 0;

// Msg Flags
const OPTS_CHECKSUM_PRESENT: number = 1;
const OPTS_MORE_TO_COME: number = 2;
const OPTS_EXHAUST_ALLOWED: number = 1 << 16;

/** Options for constructing a new message. */
export interface MsgOptions {
  readPreference?: ReadPreference;
  serializeFunctions?: boolean
  checkKeys?: boolean
  maxBSONSize?: number
  moreToCome?: boolean
}

/** A class representation of a message. */
export class Msg {
  readonly ns: string;
  readonly command: {[key:string]: any};
  // readonly options: MsgOptions;
readonly  requestId: number

  serializeFunctions: boolean;
  checkKeys: boolean;
  maxBSONSize: number;
  checksumPresent: boolean
  moreToCome: boolean
  exhaustAllowed: boolean
  
  /** Creates a new msg. */
  constructor(/*bson, */ns: string, command: {[key:string]: any}, options: MsgOptions = {}) {
    // Not-null checks
    if (!ns) { throw new MongoError("namespace must be provided")}
    if (!command){ throw new MongoError('command must be specified for msg');}

    // Basic options
    // this.bson = bson;
    this.ns = ns;
    this.command = command;
    this.command.$db = databaseNamespace(ns);

    if (options.readPreference && options.readPreference.mode !== ReadPreference.PRIMARY) {
      this.command.$readPreference = options.readPreference.toJSON();
    }

    // Ensure empty options
    // this.options = options || {};

    // Additional options
    this.requestId = Msg.getRequestId();

    // Serialization option
    this.serializeFunctions =
      typeof options.serializeFunctions === 'boolean' ? options.serializeFunctions : false;
    // this.ignoreUndefined =
    //   typeof options.ignoreUndefined === 'boolean' ? options.ignoreUndefined : false;
    this.checkKeys = typeof options.checkKeys === 'boolean' ? options.checkKeys : false;
    this.maxBSONSize = options.maxBSONSize || 1024 * 1024 * 16;

    // flags
    this.checksumPresent = false;
    this.moreToCome = options.moreToCome || false;
    this.exhaustAllowed = false;
  }
  
  /** Gets the next request id. */
  static getRequestId(): number {
    return ++_requestId;
  }

  /** Creates an array of buffers. */
  toBin(): Uint8Array[] {
    const buffers: Uint8Array[] = [];
    
    let flags: number = 0;

    if (this.checksumPresent) {
      flags |= OPTS_CHECKSUM_PRESENT;
    }

    if (this.moreToCome) {
      flags |= OPTS_MORE_TO_COME;
    }

    if (this.exhaustAllowed) {
      flags |= OPTS_EXHAUST_ALLOWED;
    }

    const header: Uint8Array = new Uint8Array(
      4 * 4 + // Header
        4 // Flags
    );

    buffers.push(header);

    let totalLength: number = header.length;
    // const command: {[key:string]: any} = this.command;
    totalLength += this.makeDocumentSegment(buffers, this.command);

    writeInt32LE(header, totalLength, 0); // messageLength
    writeInt32LE(header, this.requestId, 4); // requestID
    writeInt32LE(header, 0, 8); // responseTo
    writeInt32LE(header, OPCODES.OP_MSG, 12); // opCode
    writeUint32LE(header, flags, 16); // flags
    
    return buffers;
  }

  /** Pushes a document segment into the buffers array. */
  makeDocumentSegment(buffers: Uint8Array[], document: {[key:string]: any}): number {
    const payloadTypeBuffer: Uint8Array = new Uint8Array(1);
    // payloadTypeBuffer[0] = 0;

    const documentBuffer: Uint8Array = this.serializeBson(document);
    buffers.push(payloadTypeBuffer);
    buffers.push(documentBuffer);

    return payloadTypeBuffer.length + documentBuffer.length;
  }

  /** Serializes given document to BSON. */
  serializeBson(document: {[key:string]: any}): Uint8Array {
    return BSON.serialize(document, {
      checkKeys: this.checkKeys,
      serializeFunctions: this.serializeFunctions
      // ,ignoreUndefined: this.ignoreUndefined
    });
  }
}

// Msg.getRequestId = function() {
//   return ++_requestId;
// };

/** A class representation of a binary message. */
class BinMsg {
  
  /** Creates a new bin msg. */
  constructor(bson, message, msgHeader, msgBody, opts) {
    opts = opts || { promoteLongs: true, promoteValues: true, promoteBuffers: false };
    this.parsed = false;
    this.raw = message;
    this.data = msgBody;
    this.bson = bson;
    this.opts = opts;

    // Read the message header
    this.length = msgHeader.length;
    this.requestId = msgHeader.requestId;
    this.responseTo = msgHeader.responseTo;
    this.opCode = msgHeader.opCode;
    this.fromCompressed = msgHeader.fromCompressed;

    // Read response flags
    this.responseFlags = msgBody.readInt32LE(0);
    this.checksumPresent = (this.responseFlags & OPTS_CHECKSUM_PRESENT) !== 0;
    this.moreToCome = (this.responseFlags & OPTS_MORE_TO_COME) !== 0;
    this.exhaustAllowed = (this.responseFlags & OPTS_EXHAUST_ALLOWED) !== 0;
    this.promoteLongs = typeof opts.promoteLongs === 'boolean' ? opts.promoteLongs : true;
    this.promoteValues = typeof opts.promoteValues === 'boolean' ? opts.promoteValues : true;
    this.promoteBuffers = typeof opts.promoteBuffers === 'boolean' ? opts.promoteBuffers : false;

    this.documents = [];
  }

  isParsed() {
    return this.parsed;
  }

  parse(options) {
    // Don't parse again if not needed
    if (this.parsed) return;
    options = options || {};

    this.index = 4;
    // Allow the return of raw documents instead of parsing
    const raw = options.raw || false;
    const documentsReturnedIn = options.documentsReturnedIn || null;
    const promoteLongs =
      typeof options.promoteLongs === 'boolean' ? options.promoteLongs : this.opts.promoteLongs;
    const promoteValues =
      typeof options.promoteValues === 'boolean' ? options.promoteValues : this.opts.promoteValues;
    const promoteBuffers =
      typeof options.promoteBuffers === 'boolean'
        ? options.promoteBuffers
        : this.opts.promoteBuffers;

    // Set up the options
    const _options = {
      promoteLongs: promoteLongs,
      promoteValues: promoteValues,
      promoteBuffers: promoteBuffers
    };

    while (this.index < this.data.length) {
      const payloadType = this.data.readUInt8(this.index++);
      if (payloadType === 1) {
        console.error('TYPE 1');
      } else if (payloadType === 0) {
        const bsonSize = this.data.readUInt32LE(this.index);
        const bin = this.data.slice(this.index, this.index + bsonSize);
        this.documents.push(raw ? bin : this.bson.deserialize(bin, _options));

        this.index += bsonSize;
      }
    }

    if (this.documents.length === 1 && documentsReturnedIn != null && raw) {
      const fieldsAsRaw = {};
      fieldsAsRaw[documentsReturnedIn] = true;
      _options.fieldsAsRaw = fieldsAsRaw;

      const doc = this.bson.deserialize(this.documents[0], _options);
      this.documents = [doc];
    }

    this.parsed = true;
  }
}

module.exports = { Msg, BinMsg };
