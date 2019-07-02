// 'use strict';

// import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const inherits = require('util').inherits;
// const EventEmitter = require('events').EventEmitter;
import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
// const MongoError = require('../error').MongoError;
import { MongoError, MongoNetworkError, MongoWriteConcernError} from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const MongoWriteConcernError = require('../error').MongoWriteConcernError;
// const Logger = require('./logger');
import { Logger} from "./logger.ts"
// const f = require('util').format;
import {CONNECTION_EVENT_NAMES, Connection } from "./connection.ts"
// const Msg = require('./msg').Msg;
import { Msg, BinMsg} from "./msg.ts"
// const CommandResult = require('./command_result');
import { CommandResult } from "./command_result.ts"
// const MESSAGE_HEADER_SIZE = require('../wireprotocol/shared').MESSAGE_HEADER_SIZE;
// const COMPRESSION_DETAILS_SIZE = require('../wireprotocol/shared').COMPRESSION_DETAILS_SIZE;
// const opcodes = require('../wireprotocol/shared').opcodes;
import { MESSAGE_HEADER_SIZE, COMPRESSION_DETAILS_SIZE, OPCODES} from "./../wireprotocol/shared.ts"
// const compress = require('../wireprotocol/compression').compress;
// const compressorIDs = require('../wireprotocol/compression').compressorIDs;
// const uncompressibleCommands = require('../wireprotocol/compression').uncompressibleCommands;
import { compress, compressorIDs, uncompressibleCommands } from "./../wireprotocol/compression.ts"
// const apm = require('./apm');
import { apm } from "./apm.ts"
// const Buffer = require('safe-buffer').Buffer;
// const connect = require('./connect');
import { connect} from "./connect.ts"
// const updateSessionFromResponse = require('../sessions').updateSessionFromResponse;
import { updateSessionFromResponse} from "./../sessions.ts"
import { Callback,concat, noop, readInt32LE, writeUint8, writeInt32LE} from "./../utils.ts"

const DISCONNECTED: string = 'disconnected';
const CONNECTING: string = 'connecting';
const CONNECTED: string = 'connected';
const DESTROYING: string = 'destroying';
const DESTROYED: string = 'destroyed';

const legalTransitions: {[key:string]: string[]} = {
  disconnected: [CONNECTING, DESTROYING, DISCONNECTED],
  connecting: [CONNECTING, DESTROYING, CONNECTED, DISCONNECTED],
  connected: [CONNECTED, DISCONNECTED, DESTROYING],
  destroying: [DESTROYING, DESTROYED],
  destroyed: [DESTROYED]
};

let _id: number = 0;


function stateTransition(self: Pool, newState: string): void {
  // const legalTransitions: {[key:string]: string[]} = {
  //   disconnected: [CONNECTING, DESTROYING, DISCONNECTED],
  //   connecting: [CONNECTING, DESTROYING, CONNECTED, DISCONNECTED],
  //   connected: [CONNECTED, DISCONNECTED, DESTROYING],
  //   destroying: [DESTROYING, DESTROYED],
  //   destroyed: [DESTROYED]
  // };

  // Get current state
  const legalStates: string[] = legalTransitions[self.state];
  if (legalStates && legalStates.indexOf(newState) !== -1) {
    self.emit('stateChanged', self.state, newState);
    self.state = newState;
  } else {
    self.logger.error(
      // f(
      //   'Pool with id [%s] failed attempted illegal state transition from [%s] to [%s] only following state allowed [%s]',
      //   self.id,
      //   self.state,
      //   newState,
      //   legalStates
      // )
      `Pool with id ${self.id} attempted illegal state transition from ${self.state} to ${newState}; only following states are allowed ${legalStates}`
    );
  }
}

function connectionFailureHandler(pool: Pool, event: string, err: Error, connection: Connection): void {
  if (connection) {
    if (connection._connectionFailHandled) {return;}

    connection._connectionFailHandled = true;
    connection.destroy();

    // Remove the connection
    removeConnection(pool, connection);

    // Flush all work Items on this connection
    while (connection.workItems.length > 0) {
      const workItem:  {[key:string]: any} = connection.workItems.shift();

      if (workItem.cb) {workItem.cb(err);}
    }
  }

  // Did we catch a timeout, increment the numberOfConsecutiveTimeouts
  if (event === 'timeout') {
    pool.numberOfConsecutiveTimeouts = pool.numberOfConsecutiveTimeouts + 1;

    // Have we timed out more than reconnectTries in a row ?
    // Force close the pool as we are trying to connect to tcp sink hole
    if (pool.numberOfConsecutiveTimeouts > pool.options.reconnectTries) {
      pool.numberOfConsecutiveTimeouts = 0;
      // Destroy all connections and pool
      pool.destroy(true);
      // Emit close event
      return pool.emit('close', pool);
    }
  }

  // No more socket available propegate the event
  if (pool.socketCount() === 0) {
    if (pool.state !== DESTROYED && pool.state !== DESTROYING) {
      stateTransition(pool, DISCONNECTED);
    }

    // Do not emit error events, they are always close events
    // do not trigger the low level error handler in node
    event = event === 'error' ? 'close' : event;
    pool.emit(event, err);
  }

  // Start reconnection attempts
  if (!pool.reconnectId && pool.options.reconnect) {
    pool.reconnectId = setTimeout(attemptReconnect(pool), pool.options.reconnectInterval);
  }

  // Do we need to do anything to maintain the minimum pool size
  const totalConnections: number = totalConnectionCount(pool);

  if (totalConnections < pool.minSize) {
    _createConnection(pool);
  }
}

function attemptReconnect(self: Pool): () => void {
  return ():void => {
    self.emit('attemptReconnect', self);
    if (self.state === DESTROYED || self.state === DESTROYING){ return;}

    // We are connected do not try again
    if (self.isConnected()) {
      self.reconnectId = null;
      return;
    }

    self.connectingConnections++;

    connect(self.options, (err?: Error, connection?: Connection): void => {
      self.connectingConnections--;

      if (err) {
        if (self.logger.isDebug()) {
          self.logger.debug(`connection attempt failed with error [${JSON.stringify(err)}]`);
        }

        self.retriesLeft = self.retriesLeft - 1;

        if (self.retriesLeft <= 0) {
          self.destroy();
          self.emit(
            'reconnectFailed',
            new MongoNetworkError(
              // f(
              //   'failed to reconnect after %s attempts with interval %s ms',
              //   self.options.reconnectTries,
              //   self.options.reconnectInterval
              // )
              `failed to reconnect after ${self.options.reconnectTries} attempts with interval ${self.options.reconnectInterval} ms`
            )
          );
        } else {
          self.reconnectId = setTimeout(attemptReconnect(self), self.options.reconnectInterval);
        }

        return;
      }

      if (self.state === DESTROYED || self.state === DESTROYING) {
        return connection.destroy();
      }

      self.reconnectId = null;

      CONNECTION_EVENT_NAMES.forEach((eventName: string): void => connection.removeAllListeners(eventName));

      connection.on('error', self._connectionErrorHandler);
      connection.on('close', self._connectionCloseHandler);
      connection.on('timeout', self._connectionTimeoutHandler);
      connection.on('parseError', self._connectionParseErrorHandler);
      connection.on('message', self._messageHandler);

      self.retriesLeft = self.options.reconnectTries;

      self.availableConnections.push(connection);

      self.reconnectConnection = null;

      self.emit('reconnect', self);

      _execute(self)();
    });
  };
}

function moveConnectionBetween(connection: Connection, from: Connection[], to: Connection[]): void {
  const index: number = from.indexOf(connection);
  // Move the connection from connecting to available
  if (index !== -1) {
    from.splice(index, 1);
    to.push(connection);
  }
}

function messageHandler(self: Pool): (message: BinMsg, connection: Connection) => void {
  return (message: BinMsg, connection: Connection): void => {
    // workItem to execute
    let workItem = null;

    // Locate the workItem
    for (let i: number = 0; i < connection.workItems.length; i++) {
      if (connection.workItems[i].requestId === message.responseTo) {
        // Get the callback
        workItem = connection.workItems[i];
        // Remove from list of workItems
        connection.workItems.splice(i, 1);
      }
    }

    if (workItem && workItem.monitoring) {
      moveConnectionBetween(connection, self.inUseConnections, self.availableConnections);
    }

    // Reset timeout counter
    self.numberOfConsecutiveTimeouts = 0;

    // Reset the connection timeout if we modified it for
    // this operation
    if (workItem && workItem.socketTimeout) {
      connection.resetSocketTimeout();
    }

    // Log if debug enabled
    if (self.logger.isDebug()) {
      self.logger.debug(
        // f(
        //   'message [%s] received from %s:%s',
        //   message.raw.toString('hex'),
        //   self.options.host,
        //   self.options.port
        // )
        `message ${message.raw.toString('hex')} received from %s:%s`
      );
    }

    function handleOperationCallback(self: Pool, cb: Callback, err?: Error, result?: CommandResult): void {
      // // No domain enabled
      // if (!self.options.domainsEnabled) {
      //   // return process.nextTick(function() {
      //   //   return cb(err, result);
      //   // });
      //   setTimeout((): void => cb(err, result), 0)
      //   return
      //   // return cb(err, result)
      // }

      // Domain enabled just call the callback
      cb(err, result);
    }

    // Keep executing, ensure current message handler does not stop execution
    if (!self.executing) {
      // process.nextTick(function() {
      //   _execute(self)();
      // });
      setTimeout((): void => _execute(self)(), 0)
    }

    // Time to dispatch the message if we have a callback
    if (workItem && !workItem.immediateRelease) {
      try {
        // Parse the message according to the provided options
        message.parse(workItem);
      } catch (err) {
        return handleOperationCallback(self, workItem.cb, new MongoError(err));
      }

      if (message.documents[0]) {
        const document: {[key:string]: any} = message.documents[0];
        const session: Session = workItem.session;
        if (session) {
          updateSessionFromResponse(session, document);
        }

        if (document.$clusterTime) {
          self.topology.clusterTime = document.$clusterTime;
        }
      }

      // Establish if we have an error
      if (workItem.command && message.documents[0]) {
        const responseDoc: {[key:string]: any} = message.documents[0];

        if (responseDoc.writeConcernError) {
          const err: MongoWriteConcernError = new MongoWriteConcernError(responseDoc.writeConcernError, responseDoc);
          return handleOperationCallback(self, workItem.cb, err);
        }

        if (responseDoc.ok === 0 || responseDoc.$err || responseDoc.errmsg || responseDoc.code) {
          return handleOperationCallback(self, workItem.cb, new MongoError(responseDoc));
        }
      }

      // Add the connection details
      message.hashedName = connection.hashedName;

      // Return the documents
      handleOperationCallback(
        self,
        workItem.cb,
        null,
        new CommandResult(workItem.fullResult ? message : message.documents[0], connection, message)
      );
    }
  };
}

function totalConnectionCount(pool: Pool): number {
  return   pool.availableConnections.length + pool.inUseConnections.length + pool.connectingConnections
}

// // Events
// const CONNECTION_EVENT_NAMES: string[] = ['error', 'close', 'timeout', 'parseError', 'connect', 'message'];

// Destroy the connections
function destroy(self: Pool, connections: Connection[], options: {[key:string]:any}, callback?: Callback): void {
  let connectionCount: number = connections.length;

  function connectionDestroyed(): void {
    connectionCount--;

    if (connectionCount > 0) {
      return;
    }

    // Zero out all connections
    self.inUseConnections = [];
    self.availableConnections = [];
    self.connectingConnections = 0;

    // Set state to destroyed
    stateTransition(self, DESTROYED);

    if (typeof callback === 'function') {
      callback(null, null);
    }
  }

  if (connectionCount === 0) {
    return connectionDestroyed();
    // return;
  }

  // Destroy all connections
  connections.forEach((connection: Connection): void => {
    for (let i: number = 0; i < CONNECTION_EVENT_NAMES.length; ++i ) {
      connection.removeAllListeners(CONNECTION_EVENT_NAMES[i]);
    }

    connection.destroy(options, connectionDestroyed);
  });
}

// Prepare the buffer that Pool.prototype.write() uses to send to the server
function serializeCommand(self: Pool, command: Msg, callback: Callback): void {
  const originalCommandBuffers: Uint8Array[] = command.toBin();

  // Check whether we and the server have agreed to use a compressor
  const shouldCompress = !!self.options.agreedCompressor;

  if (!shouldCompress || !canCompress(command)) {
    return callback(null, originalCommandBuffers);
  }

  // Transform originalCommandBuffer into OP_COMPRESSED
  const concatenatedOriginalCommandBuffer: Uint8Array = concat(originalCommandBuffers);
  const messageToBeCompressed: Uint8Array = concatenatedOriginalCommandBuffer.slice(MESSAGE_HEADER_SIZE);

  // Extract information needed for OP_COMPRESSED from the uncompressed message
  // const originalCommandOpCode = concatenatedOriginalCommandBuffer.readInt32LE(12);
  const originalCommandOpCode: number = readInt32LE(concatenatedOriginalCommandBuffer, 12);

  // Compress the message body
  compress(self, messageToBeCompressed, function(err?: Error, compressedMessage?: Uint8Array): void {
    if (err) {return callback(err, null);}

    // Create the msgHeader of OP_COMPRESSED
    const msgHeader: Uint8Array = new Uint8Array(MESSAGE_HEADER_SIZE);

     // messageLength
    writeInt32LE(msgHeader,
      MESSAGE_HEADER_SIZE + COMPRESSION_DETAILS_SIZE + compressedMessage.length,
      0
    );

    // requestID
    writeInt32LE(msgHeader,command.requestId, 4);

     // responseTo (zero)
    writeInt32LE(msgHeader,0, 8);

     // opCode
    writeInt32LE(msgHeader, OPCODES.OP_COMPRESSED, 12);

    // Create the compression details of OP_COMPRESSED
    const compressionDetails = new Uint8Array(COMPRESSION_DETAILS_SIZE);

    // originalOpcode
    writeInt32LE(compressionDetails, originalCommandOpCode, 0);

     // Size of the uncompressed compressedMessage, excluding the MsgHeader
    writeInt32LE(compressionDetails, messageToBeCompressed.length, 4);

     // compressorID
    writeUint8(compressionDetails, compressorIDs[self.options.agreedCompressor], 8);

    return callback(null, [msgHeader, compressionDetails, compressedMessage]);
  });
}

// Return whether a command contains an uncompressible command term
// Will return true if command contains no uncompressible command terms
function canCompress(command: Msg | {[key:string]: any}): boolean {
  const commandDoc: {[key:string]: any} = command instanceof Msg ? command.command : command.query;
  const commandName: string = Object.keys(commandDoc)[0];
  return uncompressibleCommands.indexOf(commandName) === -1;
}

// Remove connection method
function remove(connection: Connection, connections: Connection[]): boolean {
  for (let i: number = 0; i < connections.length; i++) {
    if (connections[i] === connection) {
      connections.splice(i, 1);
      return true;
    }
  }
}

function removeConnection(self: Pool, connection: Connection): boolean {
  if (remove(connection, self.availableConnections)) {return true;}
  return remove(connection, self.inUseConnections)
}

// const HANDLERS: string[] = ['close', 'message', 'error', 'timeout', 'parseError', 'connect'];

function _createConnection(self: Pool): void {
  if (self.state === DESTROYED || self.state === DESTROYING) {
    return;
  }

  self.connectingConnections++;

  connect(self.options, (err: Error, connection: Connection) => {
    self.connectingConnections--;

    if (err) {
      if (self.logger.isDebug()) {
        self.logger.debug(`connection attempt failed with error [${JSON.stringify(err)}]`);
      }

      if (!self.reconnectId && self.options.reconnect) {
        self.reconnectId = setTimeout(attemptReconnect(self), self.options.reconnectInterval);
      }

      return;
    }

    if (self.state === DESTROYED || self.state === DESTROYING) {
      removeConnection(self, connection);
      return connection.destroy();
    }

    connection.on('error', self._connectionErrorHandler);
    connection.on('close', self._connectionCloseHandler);
    connection.on('timeout', self._connectionTimeoutHandler);
    connection.on('parseError', self._connectionParseErrorHandler);
    connection.on('message', self._messageHandler);

    if (self.state === DESTROYED || self.state === DESTROYING) {
      return connection.destroy();
    }

    // Remove the connection from the connectingConnections list
    removeConnection(self, connection);

    // Handle error
    if (err) {
      return connection.destroy();
    }

    // Push to available
    self.availableConnections.push(connection);
    // Execute any work waiting
    _execute(self)();
  });
}

function flushMonitoringOperations(queue:  {[key:string]: any}[]): void {
  for (let i: number = 0; i < queue.length; i++) {
    if (queue[i].monitoring) {
      const workItem:  {[key:string]: any} = queue[i];
      queue.splice(i, 1);
      workItem.cb(
        new MongoError({ message: 'no connection available for monitoring', driver: true })
      );
    }
  }
}

function _execute(self: Pool): () => void {
  return (): void => {
    if (self.state === DESTROYED) {return;}

    // Already executing, skip
    if (self.executing) {return;}

    // Set pool as executing
    self.executing = true;

    // New pool connections are in progress, wait them to finish
    // before executing any more operation to ensure distribution of
    // operations
    if (self.connectingConnections > 0) {
      self.executing = false;
      return;
    }

    // As long as we have available connections
    // eslint-disable-next-line
    while (true) {
      // Total availble connections
      const totalConnections: number = totalConnectionCount(self);

      // No available connections available, flush any monitoring ops
      if (self.availableConnections.length === 0) {
        // Flush any monitoring operations
        flushMonitoringOperations(self.queue);
        break;
      }

      // No queue break
      if (self.queue.length === 0) {
        break;
      }

      let connection = null;
      const connections: Connection[] = self.availableConnections.filter(conn => conn.workItems.length === 0);

      // No connection found that has no work on it, just pick one for pipelining
      if (connections.length === 0) {
        connection =
          self.availableConnections[self.connectionIndex++ % self.availableConnections.length];
      } else {
        connection = connections[self.connectionIndex++ % connections.length];
      }

      // Is the connection connected
      if (!connection.isConnected()) {
        // Remove the disconnected connection
        removeConnection(self, connection);
        // Flush any monitoring operations in the queue, failing fast
        flushMonitoringOperations(self.queue);
        break;
      }

      // Get the next work item
      const workItem:  {[key:string]: any} = self.queue.shift();

      // If we are monitoring we need to use a connection that is not
      // running another operation to avoid socket timeout changes
      // affecting an existing operation
      if (workItem.monitoring) {
        let foundValidConnection = false;

        for (let i: number = 0; i < self.availableConnections.length; i++) {
          // If the connection is connected
          // And there are no pending workItems on it
          // Then we can safely use it for monitoring.
          if (
            self.availableConnections[i].isConnected() &&
            self.availableConnections[i].workItems.length === 0
          ) {
            foundValidConnection = true;
            connection = self.availableConnections[i];
            break;
          }
        }

        // No safe connection found, attempt to grow the connections
        // if possible and break from the loop
        if (!foundValidConnection) {
          // Put workItem back on the queue
          self.queue.unshift(workItem);

          // Attempt to grow the pool if it's not yet maxsize
          if (totalConnections < self.options.size && self.queue.length > 0) {
            // Create a new connection
            _createConnection(self);
          }

          // Re-execute the operation
          setTimeout((): void => {
            _execute(self)();
          }, 10);

          break;
        }
      }

      // Don't execute operation until we have a full pool
      if (totalConnections < self.options.size) {
        // Connection has work items, then put it back on the queue
        // and create a new connection
        if (connection.workItems.length > 0) {
          // Lets put the workItem back on the list
          self.queue.unshift(workItem);
          // Create a new connection
          _createConnection(self);
          // Break from the loop
          break;
        }
      }

      // Get actual binary commands
      const buffer: unknown = workItem.buffer;

      // If we are monitoring take the connection of the availableConnections
      if (workItem.monitoring) {
        moveConnectionBetween(connection, self.availableConnections, self.inUseConnections);
      }

      // Track the executing commands on the mongo server
      // as long as there is an expected response
      if (!workItem.noResponse) {
        connection.workItems.push(workItem);
      }

      // We have a custom socketTimeout
      if (!workItem.immediateRelease && typeof workItem.socketTimeout === 'number') {
        connection.setSocketTimeout(workItem.socketTimeout);
      }

      // Capture if write was successful
      let writeSuccessful: boolean = true;

      // Put operation on the wire
      if (Array.isArray(buffer)) {
        for (let i: number = 0; i < buffer.length; i++) {
          writeSuccessful = connection.write(buffer[i]);
        }
      } else {
        writeSuccessful = connection.write(buffer);
      }

      // if the command is designated noResponse, call the callback immeditely
      if (workItem.noResponse && typeof workItem.cb === 'function') {
        workItem.cb(null, null);
      }

      if (writeSuccessful === false) {
        // If write not successful put back on queue
        self.queue.unshift(workItem);
        // Remove the disconnected connection
        removeConnection(self, connection);
        // Flush any monitoring operations in the queue, failing fast
        flushMonitoringOperations(self.queue);
        break;
      }
    }

    self.executing = false;
  };
}

/**
 * Pool events:
 *  + connect: server connected, verifies the connection is up and running
 *  + reconnect: server reconnected, verifies that the pool reconnected
 *  + close: server connection closed, all pool connections closed
 *  + error: server connection caused an error, all pool connections closed
 *  + timeout: server connection timed out, all pool connections closed
 *  + parseError: driver got an invalid msg, all pool connections closed
 *  + attemptReconnect: driver attempted to reconnect
 *  + reconnectFailed: driver exhausted all reconnect attempts
 */

/** Options for creating a new connection pool. */
export interface PoolOptions {
  host: string
  port: number
  size?: number
  minSize?: number
  reconnect?: boolean
  reconnectTries?: number
  reconnectInterval?: number
  keepAlive?: boolean
  keepAliveInitialDelay?: number
  noDelay?: boolean
  connectionTimeout?: number
  socketTimeout?: number
  monitoringSocketTimout?: number
  ssl?: boolean
  checkServerIdentity?: boolean
  ca?: Uint8Array
  crl?: Uint8Array
  cert?: Uint8Array
  key?: Uint8Array
  passPhrase?: string
  rejectUnauthorized?: boolean
  promoteValues?: boolean
  // domainsEnabled?: boolean,
  agreedCompressor?: unknown
  inTopology?: boolean,
  monitorCommands?: boolean
}

/** A class representation of a connection pool. */
export class Pool extends EventEmitter {
  readonly topology: unknown
  readonly options: PoolOptions
  readonly id: number

  retriesLeft: number
  reconnectId: number
  logger: Logger
  state: string
  availableConnections: Connection[]
  inUseConnections: Connection[]
  connectingConnections: number
  executing: boolean
  queue:  {[key:string]: any}[]
  reconnectConnection: Connection
  numberOfConsecutiveTimeouts: number
  connectionIndex: number
  _messageHandler: Callback
  _connectionCloseHandler: Callback
  _connectionErrorHandler: Callback
  _connectionTimeoutHandler: Callback
  _connectionParseErrorHandler: Callback

  /** Creates a new pool. */
  constructor(topology: unknown, options: PoolOptions) {
    // Add event listener
    // EventEmitter.call(this);
    super()

    // Store topology for later use
    this.topology = topology;

    // Add the options
    this.options =       {
            // Host and port settings
            host: 'localhost',
            port: 27017,
            // Pool default max size
            size: 5,
            // Pool default min size
            minSize: 0,
            // socket settings
            connectionTimeout: 30000,
            socketTimeout: 360000,
            keepAlive: true,
            keepAliveInitialDelay: 300000,
            noDelay: true,
            // SSL Settings
            ssl: false,
            checkServerIdentity: true,
            ca: null,
            crl: null,
            cert: null,
            key: null,
            passPhrase: null,
            rejectUnauthorized: false,
            // promoteLongs: true,
            promoteValues: true,
            // promoteBuffers: false,
            // Reconnection options
            reconnect: true,
            reconnectInterval: 1000,
            reconnectTries: 30,
            // Enable domains
            // domainsEnabled: false,
            ...options
          }

    // Identification information
    this.id = _id++;
    // Current reconnect retries
    this.retriesLeft = this.options.reconnectTries;
    this.reconnectId = null;

    // // No bson parser passed in
    // if (
    //   !options.bson ||
    //   (options.bson &&
    //     (typeof options.bson.serialize !== 'function' ||
    //       typeof options.bson.deserialize !== 'function'))
    // ) {
    //   throw new Error('must pass in valid bson parser');
    // }

    // Logger instance
    this.logger = Logger('Pool', options);
    // Pool state
    this.state = DISCONNECTED;
    // Connections
    this.availableConnections = [];
    this.inUseConnections = [];
    this.connectingConnections = 0;
    // Currently executing
    this.executing = false;
    // Operation work queue
    this.queue = [];

    // Contains the reconnect connection
    this.reconnectConnection = null;

    // Number of consecutive timeouts caught
    this.numberOfConsecutiveTimeouts = 0;
    // Current pool Index
    this.connectionIndex = 0;

    // event handlers
    const pool: Pool = this;
    this._messageHandler = messageHandler(this);
    this._connectionCloseHandler = function(err?: Error): void {
      const connection: Connection = this;
      connectionFailureHandler(pool, 'close', err, connection);
    };

    this._connectionErrorHandler = function(err?: Error): void  {
      const connection : Connection = this;
      connectionFailureHandler(pool, 'error', err, connection);
    };

    this._connectionTimeoutHandler = function(err?: Error): void  {
      const connection: Connection  = this;
      connectionFailureHandler(pool, 'timeout', err, connection);
    };

    this._connectionParseErrorHandler = function(err?: Error): void  {
      const connection: Connection  = this;
      connectionFailureHandler(pool, 'parseError', err, connection);
    };
  }

  /** Make executor available for testing. */
  static _execute (pool: Pool): () => void {
    return _execute(pool);
  }

  /** Gets the size of apool. */
  get size(): number {
    return this.options.size;
  }

  /** Gets the min size of a pool. */
  get minSize(): number {
    return this.options.minSize;
  }

  /** Gets the min size of a pool. */
  get connectionTimeout(): number {
    return this.options.connectionTimeout;
  }

  /** Gets the min size of a pool. */
  get socketTimeout(): number {
    return this.options.socketTimeout;
  }

  /**  Returns the total socket count in the pool. */
  socketCount(): number {
    return this.availableConnections.length + this.inUseConnections.length;
    // + this.connectingConnections.length;
  }

  /** Returns all pool connections. */
  allConnections(): Connection[] {
    return this.availableConnections.concat(this.inUseConnections);
  }

  /** Gets a pool connection (round-robin). */
  get(): Connection {
    return this.allConnections()[0];
  }

  /** Is the pool connected. */
  isConnected(): boolean {
    // We are in a destroyed state
    if (this.state === DESTROYED || this.state === DESTROYING) {
      return false;
    }

    // Get connections
    const connections: Connection[] = this.availableConnections.concat(this.inUseConnections);

    // Check if we have any connected connections
    for (let i: number = 0; i < connections.length; i++) {
      if (connections[i].isConnected()) return true;
    }

    // Not connected
    return false;
  }

  /** Was the pool destroyed? */
  isDestroyed(): boolean {
    return this.state === DESTROYED || this.state === DESTROYING;
  }

  /** Is the pool in a disconnected state? */
  isDisconnected(): boolean {
    return this.state === DISCONNECTED;
  }

  /** Connects a pool. */
  connect(): void {
    if (this.state !== DISCONNECTED) {
      // throw new MongoError('connection in unlawful state ' + this.state);
      throw new MongoError(`connection is in invalid state ${this.state}`);
    }

    const self: Pool = this;

    stateTransition(this, CONNECTING);

    self.connectingConnections++;

    connect(self.options, (err?:Error, connection?: Connection): void => {
      self.connectingConnections--;

      if (err) {
        if (self.logger.isDebug()) {
          self.logger.debug(`connection attempt failed with error [${JSON.stringify(err)}]`);
        }

        if (self.state === CONNECTING) {
          self.emit('error', err);
        }

        return;
      }

      if (self.state === DESTROYED || self.state === DESTROYING) {
        connection.destroy();
        return self.destroy();
      }

      // attach event handlers
      connection.on('error', self._connectionErrorHandler);
      connection.on('close', self._connectionCloseHandler);
      connection.on('timeout', self._connectionTimeoutHandler);
      connection.on('parseError', self._connectionParseErrorHandler);
      connection.on('message', self._messageHandler);

      // If we are in a topology, delegate the auth to it
      // This is to avoid issues where we would auth against an
      // arbiter
      if (self.options.inTopology) {
        stateTransition(self, CONNECTED);
        self.availableConnections.push(connection);
        return self.emit('connect', self, connection);
      }

      if (self.state === DESTROYED || self.state === DESTROYING) {
        return self.destroy();
      }

      if (err) {
        self.destroy();
        return self.emit('error', err);
      }

      stateTransition(self, CONNECTED);

      self.availableConnections.push(connection);

      if (self.minSize) {
        for (let i: number = 0; i < self.minSize; i++) {
          _createConnection(self);
        }
      }

      self.emit('connect', self, connection);
    });
  }

  /** Authenticate using a specified mechanism. */
  auth(credentials?: null, callback?: Callback): void {
    this.logger.warn("Pool.prototype.auth is a noop method")

    if (typeof callback === 'function') {callback(null, null);}
  }

  /** Logout. */
  logout(dbName?:null, callback?: Callback): void {
        this.logger.warn("Pool.prototype.logout is a noop method")

    if (typeof callback === 'function') {callback(null, null);}
  };

  /** Unrefs the pool. */
  unref(): void {
    // Get all the known connections
    const connections: Connection[] = this.availableConnections.concat(this.inUseConnections);

    connections.forEach((connection: Connection): void => connection.unref());
  };



  /** Destroys a pool. */
  destroy(force? :boolean, callback?: Callback): void {
    const self: Pool = this;

    // Do not try again if the pool is already dead
    if (this.state === DESTROYED || self.state === DESTROYING) {
      if (typeof callback === 'function') {callback(null, null);}
      return;
    }

    // Set state to destroyed
    stateTransition(this, DESTROYING);

    // Are we force closing
    if (force) {
      // Get all the known connections
      const connections: Connection[] = self.availableConnections.concat(self.inUseConnections);

      // Flush any remaining work items with
      // an error
      while (self.queue.length > 0) {
        const workItem:  {[key:string]: any} = self.queue.shift();
        if (typeof workItem.cb === 'function') {
          workItem.cb(new MongoError('Pool was force destroyed'));
        }
      }

      // Destroy the topology
      return destroy(self, connections, { force: true }, callback);
    }

    // Clear out the reconnect if set
    if (this.reconnectId) {
      clearTimeout(this.reconnectId);
    }

    // If we have a reconnect connection running, close
    // immediately
    if (this.reconnectConnection) {
      this.reconnectConnection.destroy();
    }

    // Wait for the operations to drain before we close the pool
    function checkStatus(): void | number {
      flushMonitoringOperations(self.queue);

      if (self.queue.length === 0) {
        // Get all the known connections
        const connections: Connection[] = self.availableConnections.concat(self.inUseConnections);

        // Check if we have any in flight operations
        for (let i: number = 0; i < connections.length; i++) {
          // There is an operation still in flight, reschedule a
          // check waiting for it to drain
          if (connections[i].workItems.length > 0) {
            return setTimeout(checkStatus, 1);
          }
        }

        destroy(self, connections, { force: false }, callback);
        // } else if (self.queue.length > 0 && !this.reconnectId) {
      } else {
        // Ensure we empty the queue
        _execute(self)();
        // Set timeout
        setTimeout(checkStatus, 1);
      }
    }

    // Initiate drain of operations
    checkStatus();
  };

  /** Resets all connections of this pool.  */
  reset(callback: Callback): void {
    // this.destroy(true, err => {
    //   if (err && typeof callback === 'function') {
    //     callback(err, null);
    //     return;
    //   }

    //   stateTransition(this, DISCONNECTED);
    //   this.connect();

    //   if (typeof callback === 'function') callback(null, null);
    // });
      this.logger.warn("Pool.prototype.reset is a noop method")

    if (typeof callback === 'function') {callback(null, null);}
  };



  /** Write a message to MongoDB. */
  write(command: {[key:string]: any}, options: any = {}, callback: Callback=noop): void {
    const self: Pool = this;

    // Ensure we have a callback
    if (typeof options === 'function') {
      callback = options;
      options = {}
    }

    // Always have options
    options = options || {};

    // We need to have a callback function unless the message returns no response
    if (typeof callback !== 'function' && !options.noResponse) {
      throw new MongoError('Pool.prototype.write must have a callback');
    }

    // Pool was destroyed error out
    if (this.state === DESTROYED || this.state === DESTROYING) {
      // Callback with an error
      if (callback) {
        callback(new MongoError('Pool is destroyed, cannot write to it.'))
      }

      return;
    }

    // if (this.options.domainsEnabled && process.domain && typeof cb === 'function') {
    //   // if we have a domain bind to it
    //   var oldCb = cb;
    //   cb = process.domain.bind(function() {
    //     // v8 - argumentsToArray one-liner
    //     var args = new Array(arguments.length);
    //     for (var i = 0; i < arguments.length; i++) {
    //       args[i] = arguments[i];
    //     }
    //     // bounce off event loop so domain switch takes place
    //     process.nextTick(function() {
    //       oldCb.apply(null, args);
    //     });
    //   });
    // }

    // Do we have an operation
    const operation: {[key:string]: any} = {
      cb: callback,
      raw: false,
      // promoteLongs: true,
      promoteValues: true,
      // promoteBuffers: false,
      fullResult: false
    };

    // Set the options for the parsing
    // operation.promoteLongs = typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true;
    operation.promoteValues =
      typeof options.promoteValues === 'boolean' ? options.promoteValues : true;
    // operation.promoteBuffers =
    //   typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false;
    operation.raw = typeof options.raw === 'boolean' ? options.raw : false;
    operation.immediateRelease =
      typeof options.immediateRelease === 'boolean' ? options.immediateRelease : false;
    operation.documentsReturnedIn = options.documentsReturnedIn;
    operation.command = typeof options.command === 'boolean' ? options.command : false;
    operation.fullResult = typeof options.fullResult === 'boolean' ? options.fullResult : false;
    operation.noResponse = typeof options.noResponse === 'boolean' ? options.noResponse : false;
    operation.session = options.session || null;

    // Optional per operation socketTimeout
    operation.socketTimeout = options.socketTimeout;
    operation.monitoring = options.monitoring;
    // Custom socket Timeout
    if (options.socketTimeout) {
      operation.socketTimeout = options.socketTimeout;
    }

    // Get the requestId
    operation.requestId = command.requestId;

    // If command monitoring is enabled we need to modify the callback here
    if (self.options.monitorCommands) {
      self.emit('commandStarted', new apm.CommandStartedEvent(this, command));

      // operation.started = process.hrtime();
      operation.started = performance.now()

      operation.cb = (err: Error, reply: {[key:string]: any}): void => {
        if (err) {
          self.emit(
            'commandFailed',
            new apm.CommandFailedEvent(this, command, err, operation.started)
          );
        } else {
          if (reply && reply.result && (reply.result.ok === 0 || reply.result.$err)) {
            self.emit(
              'commandFailed',
              new apm.CommandFailedEvent(this, command, reply.result, operation.started)
            );
          } else {
            self.emit(
              'commandSucceeded',
              new apm.CommandSucceededEvent(this, command, reply, operation.started)
            );
          }
        }

        if (typeof callback === 'function'){ callback(err, reply);}
      };
    }

    // Prepare the operation buffer
    serializeCommand(self, command, (err: Error, serializedBuffers: Uint8Array[]): any => {
      // if (err) throw err;
      if (err) {
        return callback(err, null)
      }

      // Set the operation's buffer to the serialization of the commands
      operation.buffer = serializedBuffers;

      // If we have a monitoring operation schedule as the very first operation
      // Otherwise add to back of queue
      if (options.monitoring) {
        self.queue.unshift(operation);
      } else {
        self.queue.push(operation);
      }

      // Attempt to execute the operation
      if (!self.executing) {
        // process.nextTick(function() {
        //   _execute(self)();
        // });
        setTimeout((): void => _execute(self)(), 0)
      }
    });
  };

}
//
// var Pool = function(topology, options) {
//   // Add event listener
//   EventEmitter.call(this);
//
//   // Store topology for later use
//   this.topology = topology;
//
//   // Add the options
//   this.options = Object.assign(
//     {
//       // Host and port settings
//       host: 'localhost',
//       port: 27017,
//       // Pool default max size
//       size: 5,
//       // Pool default min size
//       minSize: 0,
//       // socket settings
//       connectionTimeout: 30000,
//       socketTimeout: 360000,
//       keepAlive: true,
//       keepAliveInitialDelay: 300000,
//       noDelay: true,
//       // SSL Settings
//       ssl: false,
//       checkServerIdentity: true,
//       ca: null,
//       crl: null,
//       cert: null,
//       key: null,
//       passPhrase: null,
//       rejectUnauthorized: false,
//       promoteLongs: true,
//       promoteValues: true,
//       promoteBuffers: false,
//       // Reconnection options
//       reconnect: true,
//       reconnectInterval: 1000,
//       reconnectTries: 30,
//       // Enable domains
//       domainsEnabled: false
//     },
//     options
//   );
//
//   // Identification information
//   this.id = _id++;
//   // Current reconnect retries
//   this.retriesLeft = this.options.reconnectTries;
//   this.reconnectId = null;
//   // No bson parser passed in
//   if (
//     !options.bson ||
//     (options.bson &&
//       (typeof options.bson.serialize !== 'function' ||
//         typeof options.bson.deserialize !== 'function'))
//   ) {
//     throw new Error('must pass in valid bson parser');
//   }
//
//   // Logger instance
//   this.logger = Logger('Pool', options);
//   // Pool state
//   this.state = DISCONNECTED;
//   // Connections
//   this.availableConnections = [];
//   this.inUseConnections = [];
//   this.connectingConnections = 0;
//   // Currently executing
//   this.executing = false;
//   // Operation work queue
//   this.queue = [];
//
//   // Contains the reconnect connection
//   this.reconnectConnection = null;
//
//   // Number of consecutive timeouts caught
//   this.numberOfConsecutiveTimeouts = 0;
//   // Current pool Index
//   this.connectionIndex = 0;
//
//   // event handlers
//   const pool = this;
//   this._messageHandler = messageHandler(this);
//   this._connectionCloseHandler = function(err) {
//     const connection = this;
//     connectionFailureHandler(pool, 'close', err, connection);
//   };
//
//   this._connectionErrorHandler = function(err) {
//     const connection = this;
//     connectionFailureHandler(pool, 'error', err, connection);
//   };
//
//   this._connectionTimeoutHandler = function(err) {
//     const connection = this;
//     connectionFailureHandler(pool, 'timeout', err, connection);
//   };
//
//   this._connectionParseErrorHandler = function(err) {
//     const connection = this;
//     connectionFailureHandler(pool, 'parseError', err, connection);
//   };
// };
//
// inherits(Pool, EventEmitter);

//   /** Size of a pool. */
// Object.defineProperty(Pool.prototype, 'size', {
//   enumerable: true,
//   get(): number {
//     return this.options.size;
//   }
// });
//
//   /** Min size of a pool. */
// Object.defineProperty(Pool.prototype, 'minSize', {
//   enumerable: true,
//   get(): number {
//     return this.options.minSize;
//   }
// });
//
//   /** Connection timeout setting of a pool. */
// Object.defineProperty(Pool.prototype, 'connectionTimeout', {
//   enumerable: true,
//   get(): number {
//     return this.options.connectionTimeout;
//   }
// });
//
//   /** Socket timeout setting of a pool. */
// Object.defineProperty(Pool.prototype, 'socketTimeout', {
//   enumerable: true,
//   get(): number {
//     return this.options.socketTimeout;
//   }
// });





//
// // // Make execution loop available for testing
// // Pool._execute = _execute;
//


// module.exports = Pool;
