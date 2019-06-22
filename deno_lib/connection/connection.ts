// const EventEmitter = require('events').EventEmitter;
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
import { sha1 } from "https://denopkg.com/chiefbiiko/sha1/mod.ts"
import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
import { encode, decode } from "https://denopkg.com/chiefbiiko/std-encoding/mod.ts"
// const crypto = require('crypto');
// const debugOptions = require('./utils').debugOptions;
import { debugOptions} from "./utils.ts";
// const parseHeader = require('../wireprotocol/shared').parseHeader;
import { parseHeader } from "./wureprotocol/shared.ts"
// const decompress = require('../wireprotocol/compression').decompress;
import { decompress } from "./../wireprotocol/compression.ts";
// const Response = require('./commands').Response;
import { Respone } from "./commands.ts"
// const BinMsg = require('./msg').BinMsg;
import {BinMsg} from "./msg.ts";
// const MongoNetworkError = require('../error').MongoNetworkError;
import { MongoError, MongoNetworkError} from "./../errors.ts"
// const MongoError = require('../error').MongoError;
// const Logger = require('./logger');
import { Logger } from "./logger.ts"
import { OP_CODES, MESSAGE_HEADER_SIZE } from "./../wireprotocol/shared.ts"

function noop(): void {}

/**
 * Performs non-blocking automatic reads, similar to push-based APIs, with the
 * ondata listener being called with every read data chunk.
 */
function pullNonBlocking(
  reader: Deno.Reader,
  ondata: (chunk: Uint8Array) => any,
  onerror?: (err: Error) => any
): Promise<void> {
  const it: AsyncIterableIterator<Uint8Array> = Deno.toAsyncIterator(reader);
  let result: { done: boolean; value: Uint8Array };

  return new Promise(
    async (): Promise<void> => {
      for (;;) {
        result = await it.next();

        if (result.done) {
          break;
        }

        ondata(result.value);
      }
    }
  ).catch(onerror || noop);
}

/** Concatenates given buffers. */
function concat(bufs: Uint8Array[]): Uint8Array {
  const total: number = bufs.reduce(
    (acc, cur): number => acc + cur.byteLength,
    0
  );

  const buf: Uint8Array = new Uint8Array(total);
  let offset: number = 0;

  for (const b of bufs) {
    buf.set(b, offset);
    offset += b.byteLength;
  }

  return buf;
}

const OP_COMPRESSED: number = OP_CODES.OP_COMPRESSED;

const OP_MSG: number = OP_CODES.OP_MSG;
// const MESSAGE_HEADER_SIZE = require('../wireprotocol/shared').MESSAGE_HEADER_SIZE;
// const Buffer = require('safe-buffer').Buffer;

let _id: number = 0;

const DEFAULT_MAX_BSON_MESSAGE_SIZE: number = 1024 * 1024 * 16 * 4;
const DEBUG_FIELDS: string[] = [
  'host',
  'port',
  'size',
  'keepAlive',
  'keepAliveInitialDelay',
  'noDelay',
  'connectionTimeout',
  'socketTimeout',
  'ssl',
  'ca',
  'crl',
  'cert',
  'rejectUnauthorized',
  'promoteLongs',
  'promoteValues',
  'promoteBuffers',
  'checkServerIdentity'
];

let connectionAccountingSpy: any = undefined;
let connectionAccounting: boolean = false;
let connections: { [key:number]: Connection} = {};

export interface ConnectionOptions {
  maxBSONMessageSize?: number;
  port?: number
  host?:string
  socketTimeout?: number
  connectionTimeout?: number;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  promoteValues?: boolean
}

/**
 * A class representing a single connection to a MongoDB server
 * Emits the following events: "connect", "close", "error", "timeout",
 * "parseError", and "message".
 */
export class Connection extends EventEmitter {

  readonly id: number;
  readonly options: ConnectionOptions;
  readonly logger: Logger
  readonly maxBSONMessageSize: number
  readonly port: number
  readonly host: string
  readonly socketTimeout: number
  readonly keepAlive: boolean
  readonly keepAliveInitialDelay: number
  readonly connectionTimeout: number;
  readonly responseOptions: { [key:string]: any}
  readonly   conn: Deno.Conn

  flushing: boolean
  queue:  unknown[]
  writeStream: unknown
  destroyed: boolean
  hashedName: string
  workItems: unknown[]




  //
  // /**
  //  * Creates a new Connection instance
  //  *
  //  * @param {Socket} socket The socket this connection wraps
  //  * @param {Object} [options] Optional settings
  //  * @param {string} [options.host] The host the socket is connected to
  //  * @param {number} [options.port] The port used for the socket connection
  //  * @param {boolean} [options.keepAlive=true] TCP Connection keep alive enabled
  //  * @param {number} [options.keepAliveInitialDelay=300000] Initial delay before TCP keep alive enabled
  //  * @param {number} [options.connectionTimeout=30000] TCP Connection timeout setting
  //  * @param {number} [options.socketTimeout=360000] TCP Socket timeout setting
  //  * @param {boolean} [options.promoteLongs] Convert Long values from the db into Numbers if they fit into 53 bits
  //  * @param {boolean} [options.promoteValues] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
  //  * @param {boolean} [options.promoteBuffers] Promotes Binary BSON values to native Node Buffers.
  //  */

  constructor(conn: Deno.Conn , options: ConnectionOptions = {}) {
    super();

    // options = options || {};
    // if (!options.bson) {
    //   throw new TypeError('must pass in valid bson parser');
    // }

    this.id = _id++;
    this.options = options;
    this.logger = Logger('Connection', options);
    // this.bson = options.bson;
    // this.tag = options.tag;
    this.maxBSONMessageSize = options.maxBSONMessageSize || DEFAULT_MAX_BSON_MESSAGE_SIZE;

    this.port = options.port || 27017;
    this.host = options.host || 'localhost';
    this.socketTimeout = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;

    // These values are inspected directly in tests, but maybe not necessary to keep around
    this.keepAlive = typeof options.keepAlive === 'boolean' ? options.keepAlive : true;
    this.keepAliveInitialDelay =
      typeof options.keepAliveInitialDelay === 'number' ? options.keepAliveInitialDelay : 300000;
    this.connectionTimeout =
      typeof options.connectionTimeout === 'number' ? options.connectionTimeout : 30000;
    if (this.keepAliveInitialDelay > this.socketTimeout) {
      this.keepAliveInitialDelay = Math.round(this.socketTimeout / 2);
    }

    // Debug information
    if (this.logger.isDebug()) {
      this.logger.debug(
        `creating connection ${this.id} with options [${JSON.stringify(
          debugOptions(DEBUG_FIELDS, options)
        )}]`
      );
    }

    // Response options
    this.responseOptions = {
      // promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
      promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
      // promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false
    };

    // Flushing
    this.flushing = false;
    this.queue = [];

    // Internal state
    this.writeStream = null;
    this.destroyed = false;

    // Create hash method
    // const hash = crypto.createHash('sha1');
    // hash.update(this.address);
    // this.hashedName = hash.digest('hex');

    this.hashedName = sha1(this.address, "utf8", "hex")

    // All operations in flight on the connection
    this.workItems = [];

    // setup socket
    this.conn = conn;
    // this.conn.once('error', errorHandler(this));
    // this.conn.once('timeout', timeoutHandler(this));
    // this.conn.once('close', closeHandler(this));
    this.conn.on('data', dataHandler(this));

    // need to block with conn's pull-based API, isolate in micro-thread
    pullNonBlocking(conn, dataHandler(this), errorHandler(this));

    if (connectionAccounting) {
      addConnection(this.id, this);
    }
  }

  // setSocketTimeout(value) {
  //   if (this.socket) {
  //     this.socket.setTimeout(value);
  //   }
  // }

  // resetSocketTimeout() {
  //   if (this.socket) {
  //     this.socket.setTimeout(this.socketTimeout);
  //   }
  // }

  static enableConnectionAccounting(spy: any): void {
    if (spy) {
      connectionAccountingSpy = spy;
    }

    connectionAccounting = true;
    connections = {};
  }

  static disableConnectionAccounting(): void {
    connectionAccounting = false;
    connectionAccountingSpy = undefined;
  }

  static connections(): {[key:number]: Connection} {
    return connections;
  }

  get address(): string {
    return `${this.host}:${this.port}`;
  }

  // /**
  //  * Unref this connection
  //  * @method
  //  * @return {boolean}
  //  */
  // unref() {
  //   if (this.socket == null) {
  //     this.once('connect', () => this.socket.unref());
  //     return;
  //   }
  //
  //   this.socket.unref();
  // }

  /** Destroys a connection. */
  destroy(/*options: {force: boolean}, callback*/): void {
    // if (typeof options === 'function') {
    //   callback = options;
    //   options = {};
    // }

    // options = Object.assign({ force: false }, options);

    if (connectionAccounting) {
      deleteConnection(this.id);
    }

    if (!this.destroyed && this.conn) {
      this.conn.close();
    }

    this.destroyed = true;

    // if (options.force) {
    //   this.socket.destroy();
    //   this.destroyed = true;
    //   if (typeof callback === 'function') callback(null, null);
    //   return;
    // }
    //
    // this.socket.end(err => {
    //   this.destroyed = true;
    //   if (typeof callback === 'function') callback(err, null);
    // });
  }

  /** Writes one or multiple buffers to a connection. */
  async write(buf: Uint8Array | Uint8Array[]): Promise<number> {
    // Maybe concat bufs
   const b: Uint8Array = Array.isArray(buf) ? concat(buf): buf
    // if (Array.isArray(buf)) {
    //   b = concat(buf)
    // } else {
    //   b = buf
    // }

    // Debug Log
    if (this.logger.isDebug() && !this.destroyed) {
      this.logger.debug(`writing buffer [${decode(b, "hex")}] to ${this.address}`);
      // if (!Array.isArray(buf)) {
      //   this.logger.debug(`writing buffer [${decode(buf, "hex")}] to ${this.address}`);
      // } else {
      //   for (const b of buf)
      //     {this.logger.debug(`writing buffer [${decode(b, "hex")}] to ${this.address}`);}
      // }
    }

    // Double check that the connection is not destroyed
    return this.destroyed ? 0 : this.conn.write(b)
    // if (!this.destroyed) {
    //   // Write out the command
    //   return this.conn.write(b)
    //
    //   // if (!Array.isArray(b)) {
    //     // this.socket.write(buffer, 'binary');
    //     // return true;
    //   // }
    //
    //   // // Iterate over all buffers and write them in order to the socket
    //   // for (let i = 0; i < buffer.length; i++) {
    //   //   this.socket.write(buffer[i], 'binary');
    //   // }
    //
    //   // return true;
    // }
    //
    // // Connection is destroyed return write failed
    // return 0;
  }

  /** Connection id as string. */
  toString(): string {
    return `${this.id}`;
  }

  /** JSON representation of a connection. */
  toJSON(): { id: number, host: string, port: number } {
    return { id: this.id, host: this.host, port: this.port };
  }

  /** Whether a connection is connected to its remoteAddress. */
  isConnected(): boolean {
    if (this.destroyed) {return false;}
    return !this.conn.destroyed// && this.socket.writable;
  }
}

function deleteConnection(id: number): void {
  // console.log("=== deleted connection " + id + " :: " + (connections[id] ? connections[id].port : ''))
  delete connections[id];

  if (connectionAccountingSpy) {
    connectionAccountingSpy.deleteConnection(id);
  }
}

function addConnection(id: number, connection: Connection): void {
  // console.log("=== added connection " + id + " :: " + connection.port)
  connections[id] = connection;

  if (connectionAccountingSpy) {
    connectionAccountingSpy.addConnection(id, connection);
  }
}

// Connection handlers
function errorHandler(connection: Connection): (err?: Error) => void  {
  return (err?: Error): void => {
    if (connectionAccounting){ deleteConnection(connection.id);}

    if (connection.logger.isDebug()) {
      connection.logger.debug(
        `connection ${connection.id} for [${connection.address}] errored out with [${JSON.stringify(err)}]`
      );
    }

    connection.emit('error', new MongoNetworkError(err), connection);
  };
}

// function timeoutHandler(conn) {
//   return function() {
//     if (connectionAccounting) deleteConnection(conn.id);
//
//     if (conn.logger.isDebug()) {
//       conn.logger.debug(`connection ${conn.id} for [${conn.address}] timed out`);
//     }
//
//     conn.emit(
//       'timeout',
//       new MongoNetworkError(`connection ${conn.id} to ${conn.address} timed out`),
//       conn
//     );
//   };
// }
//
// function closeHandler(conn) {
//   return function(hadError) {
//     if (connectionAccounting) deleteConnection(conn.id);
//
//     if (conn.logger.isDebug()) {
//       conn.logger.debug(`connection ${conn.id} with for [${conn.address}] closed`);
//     }
//
//     if (!hadError) {
//       conn.emit(
//         'close',
//         new MongoNetworkError(`connection ${conn.id} to ${conn.address} closed`),
//         conn
//       );
//     }
//   };
// }

// Handle a message once it is received
function processMessage(conn, message) {
  const msgHeader = parseHeader(message);
  if (msgHeader.opCode !== OP_COMPRESSED) {
    const ResponseConstructor = msgHeader.opCode === OP_MSG ? BinMsg : Response;
    conn.emit(
      'message',
      new ResponseConstructor(
        conn.bson,
        message,
        msgHeader,
        message.slice(MESSAGE_HEADER_SIZE),
        conn.responseOptions
      ),
      conn
    );

    return;
  }

  msgHeader.fromCompressed = true;
  let index = MESSAGE_HEADER_SIZE;
  msgHeader.opCode = message.readInt32LE(index);
  index += 4;
  msgHeader.length = message.readInt32LE(index);
  index += 4;
  const compressorID = message[index];
  index++;

  decompress(compressorID, message.slice(index), (err, decompressedMsgBody) => {
    if (err) {
      conn.emit('error', err);
      return;
    }

    if (decompressedMsgBody.length !== msgHeader.length) {
      conn.emit(
        'error',
        new MongoError(
          'Decompressing a compressed message from the server failed. The message is corrupt.'
        )
      );

      return;
    }

    const ResponseConstructor = msgHeader.opCode === OP_MSG ? BinMsg : Response;
    conn.emit(
      'message',
      new ResponseConstructor(
        conn.bson,
        message,
        msgHeader,
        decompressedMsgBody,
        conn.responseOptions
      ),
      conn
    );
  });
}

function dataHandler(conn) {
  return function(data) {
    // Parse until we are done with the data
    while (data.length > 0) {
      // If we still have bytes to read on the current message
      if (conn.bytesRead > 0 && conn.sizeOfMessage > 0) {
        // Calculate the amount of remaining bytes
        const remainingBytesToRead = conn.sizeOfMessage - conn.bytesRead;
        // Check if the current chunk contains the rest of the message
        if (remainingBytesToRead > data.length) {
          // Copy the new data into the exiting buffer (should have been allocated when we know the message size)
          data.copy(conn.buffer, conn.bytesRead);
          // Adjust the number of bytes read so it point to the correct index in the buffer
          conn.bytesRead = conn.bytesRead + data.length;

          // Reset state of buffer
          data = Buffer.alloc(0);
        } else {
          // Copy the missing part of the data into our current buffer
          data.copy(conn.buffer, conn.bytesRead, 0, remainingBytesToRead);
          // Slice the overflow into a new buffer that we will then re-parse
          data = data.slice(remainingBytesToRead);

          // Emit current complete message
          const emitBuffer = conn.buffer;
          // Reset state of buffer
          conn.buffer = null;
          conn.sizeOfMessage = 0;
          conn.bytesRead = 0;
          conn.stubBuffer = null;

          processMessage(conn, emitBuffer);
        }
      } else {
        // Stub buffer is kept in case we don't get enough bytes to determine the
        // size of the message (< 4 bytes)
        if (conn.stubBuffer != null && conn.stubBuffer.length > 0) {
          // If we have enough bytes to determine the message size let's do it
          if (conn.stubBuffer.length + data.length > 4) {
            // Prepad the data
            const newData = Buffer.alloc(conn.stubBuffer.length + data.length);
            conn.stubBuffer.copy(newData, 0);
            data.copy(newData, conn.stubBuffer.length);
            // Reassign for parsing
            data = newData;

            // Reset state of buffer
            conn.buffer = null;
            conn.sizeOfMessage = 0;
            conn.bytesRead = 0;
            conn.stubBuffer = null;
          } else {
            // Add the the bytes to the stub buffer
            const newStubBuffer = Buffer.alloc(conn.stubBuffer.length + data.length);
            // Copy existing stub buffer
            conn.stubBuffer.copy(newStubBuffer, 0);
            // Copy missing part of the data
            data.copy(newStubBuffer, conn.stubBuffer.length);
            // Exit parsing loop
            data = Buffer.alloc(0);
          }
        } else {
          if (data.length > 4) {
            // Retrieve the message size
            const sizeOfMessage = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            // If we have a negative sizeOfMessage emit error and return
            if (sizeOfMessage < 0 || sizeOfMessage > conn.maxBsonMessageSize) {
              const errorObject = {
                err: 'socketHandler',
                trace: '',
                bin: conn.buffer,
                parseState: {
                  sizeOfMessage: sizeOfMessage,
                  bytesRead: conn.bytesRead,
                  stubBuffer: conn.stubBuffer
                }
              };
              // We got a parse Error fire it off then keep going
              conn.emit('parseError', errorObject, conn);
              return;
            }

            // Ensure that the size of message is larger than 0 and less than the max allowed
            if (
              sizeOfMessage > 4 &&
              sizeOfMessage < conn.maxBsonMessageSize &&
              sizeOfMessage > data.length
            ) {
              conn.buffer = Buffer.alloc(sizeOfMessage);
              // Copy all the data into the buffer
              data.copy(conn.buffer, 0);
              // Update bytes read
              conn.bytesRead = data.length;
              // Update sizeOfMessage
              conn.sizeOfMessage = sizeOfMessage;
              // Ensure stub buffer is null
              conn.stubBuffer = null;
              // Exit parsing loop
              data = Buffer.alloc(0);
            } else if (
              sizeOfMessage > 4 &&
              sizeOfMessage < conn.maxBsonMessageSize &&
              sizeOfMessage === data.length
            ) {
              const emitBuffer = data;
              // Reset state of buffer
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Exit parsing loop
              data = Buffer.alloc(0);
              // Emit the message
              processMessage(conn, emitBuffer);
            } else if (sizeOfMessage <= 4 || sizeOfMessage > conn.maxBsonMessageSize) {
              const errorObject = {
                err: 'socketHandler',
                trace: null,
                bin: data,
                parseState: {
                  sizeOfMessage: sizeOfMessage,
                  bytesRead: 0,
                  buffer: null,
                  stubBuffer: null
                }
              };
              // We got a parse Error fire it off then keep going
              conn.emit('parseError', errorObject, conn);

              // Clear out the state of the parser
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Exit parsing loop
              data = Buffer.alloc(0);
            } else {
              const emitBuffer = data.slice(0, sizeOfMessage);
              // Reset state of buffer
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Copy rest of message
              data = data.slice(sizeOfMessage);
              // Emit the message
              processMessage(conn, emitBuffer);
            }
          } else {
            // Create a buffer that contains the space for the non-complete message
            conn.stubBuffer = Buffer.alloc(data.length);
            // Copy the data to the stub buffer
            data.copy(conn.stubBuffer, 0);
            // Exit parsing loop
            data = Buffer.alloc(0);
          }
        }
      }
    }
  };
}

/**
 * A server connect event, used to verify that the connection is up and running
 *
 * @event Connection#connect
 * @type {Connection}
 */

/**
 * The server connection closed, all pool connections closed
 *
 * @event Connection#close
 * @type {Connection}
 */

/**
 * The server connection caused an error, all pool connections closed
 *
 * @event Connection#error
 * @type {Connection}
 */

/**
 * The server connection timed out, all pool connections closed
 *
 * @event Connection#timeout
 * @type {Connection}
 */

/**
 * The driver experienced an invalid message, all pool connections closed
 *
 * @event Connection#parseError
 * @type {Connection}
 */

/**
 * An event emitted each time the connection receives a parsed message from the wire
 *
 * @event Connection#message
 * @type {Connection}
 */

module.exports = Connection;
