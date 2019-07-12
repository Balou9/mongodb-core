// 'use strict';
import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
// import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const MongoError = require('../error').MongoError;
import { MongoError, MongoNetworkError, MongoParseError} from "./../errors.ts"
// const EventEmitter = require('events');
// const MongoError = require('../error').MongoError;
import { Topology} from "./topology.ts"
// const Pool = require('../connection/pool');
import { Pool} from "./../connection/pool.ts"
// const relayEvents = require('../utils').relayEvents;
import { Callback, collationNotSupported,noop, relayEvents } from "./../utils.ts"
// const wireProtocol = require('../wireprotocol');
import * as wireProtocol from "./../wireprotocol/mod.ts"
// const BSON = require('../connection/utils').retrieveBSON();
// const createClientInfo = require('../topologies/shared').createClientInfo;
import { ClientInfo, createClientInfo } from "./../topologies/shared.ts"
// const Logger = require('../connection/logger');
import { Logger } from "./../connection/logger.ts"
import {Connection } from "./../connection/connection.ts"
// const ServerDescription = require('./server_description').ServerDescription;
import { ServerDescription} from "./server_description.ts"
// const ReadPreference = require('../topologies/read_preference');
import { ReadPreference} from "./../topologies/read_preference.ts"
// const monitorServer = require('./monitoring').monitorServer;
import { monitorServer} from "./monitoring.ts"
import {MongoCredentials} from "./../auth/mongo_credentials.ts"
// const MongoParseError = require('../error').MongoParseError;
// const MongoNetworkError = require('../error').MongoNetworkError;
// const collationNotSupported = require('../utils').collationNotSupported;
// const debugOptions = require('../connection/utils').debugOptions;
import { debugOptions} from "./../connection/utils.ts"

interface ServerOpCallback extends Callback {
  operationId: number
}

// Used for filtering out fields for logging
const DEBUG_FIELDS: string[] = [
  'reconnect',
  'reconnectTries',
  'reconnectInterval',
  'emitError',
  'cursorFactory',
  'host',
  'port',
  'size',
  'keepAlive',
  'keepAliveInitialDelay',
  'noDelay',
  'connectionTimeout',
  'checkServerIdentity',
  'socketTimeout',
  'ssl',
  'ca',
  'crl',
  'cert',
  'key',
  'rejectUnauthorized',
  // 'promoteLongs',
  'promoteValues',
  // 'promoteBuffers',
  'servername'
];

const STATE_DISCONNECTED: number = 0;
const STATE_CONNECTING: number = 1;
const STATE_CONNECTED: number = 2;

 /**
  * Server events:
  *  + serverHeartbeatStarted: emitted when a heartbeat started
  *  + serverHeartbeatSucceeded emitted when a heartbeat succeeded
  *  + serverHeartbeatFailed: emitted when a heartbeat failed
  */

 /** A class representatino of a server. */
export class Server extends EventEmitter {
  readonly s: {
    description: ServerDescription,
    options: {[key:string]: any},
    logger: Logger,
    clientInfo: ClientInfo,
    monitoring: boolean,
    monitorFunction: (server: Server, ...rest: any[]) => void,
    pool: Pool,
    state: number,
    credentials: MongoCredentials,
    topology: Topology,
    monitorId?: number,
    clusterTime?: unknown,
    lastIsMasterMs?: number,
        // TODO: check if we actually ned this prop !!!
    sclusterTime?: unknown
  }
  /** Creates a server. */
  constructor(description: ServerDescription, options: {[key: string]: any}, topology: Topology) {
    super();

    this.s = {
      // the server description
      description,
      // a saved copy of the incoming options
      options,
      // the server logger
      logger: Logger('Server', options),
      // the bson parser
      // bson: options.bson || new BSON(),
      // client metadata for the initial handshake
      clientInfo: createClientInfo(options),
      // state variable to determine if there is an active server check in progress
      monitoring: false,
      // the implementation of the monitoring method
      monitorFunction: options.monitorFunction || monitorServer,
      // the connection pool
      pool: null,
      // the server state
      state: STATE_DISCONNECTED,
      credentials: options.credentials,
      topology
    };
  }

  /** Gets the server description. */
  get description() {
    return this.s.description;
  }

  /** Gets the server name. */
  get name() {
    return this.s.description.address;
  }

  get clusterTime(): unknown {
    return this.s.topology.clusterTime;
  }

  set clusterTime(clusterTime: unknown) {
    this.s.topology.clusterTime = clusterTime;
  }

  /** Initiate server connect. */
  connect(options: {[key:string]: any}={} ): void {
    // options = options || {};

    // do not allow connect to be called on anything that's not disconnected
    if (this.s.pool && !this.s.pool.isDisconnected() && !this.s.pool.isDestroyed()) {
      throw new MongoError(`Server instance in invalid state ${this.s.pool.state}`);
    }

    // create a pool
    const addressParts: string[] = this.description.address.split(':');

    const poolOptions: {[key:string]: any} = {
      host: addressParts[0],
      port: parseInt(addressParts[1], 10),
      ...this.s.options,
      ...options
    }
    //  Object.assign(
    //   { host: addressParts[0], port: parseInt(addressParts[1], 10) },
    //   this.s.options,
    //   options
    //   // ,{ bson: this.s.bson }
    // );

    // NOTE: this should only be the case if we are connecting to a single server
    poolOptions.reconnect = true;

    this.s.pool = new Pool(this, poolOptions);

    // setup listeners
    this.s.pool.on('connect', connectEventHandler(this));
    this.s.pool.on('close', errorEventHandler(this));
    this.s.pool.on('error', errorEventHandler(this));
    this.s.pool.on('parseError', parseErrorEventHandler(this));

    // it is unclear whether consumers should even know about these events
    // this.s.pool.on('timeout', timeoutEventHandler(this));
    // this.s.pool.on('reconnect', reconnectEventHandler(this));
    // this.s.pool.on('reconnectFailed', errorEventHandler(this));

    // relay all command monitoring events
    relayEvents(this.s.pool, this, ['commandStarted', 'commandSucceeded', 'commandFailed']);

    this.s.state = STATE_CONNECTING;

    // If auth settings have been provided, use them
    if (options.auth) {
      return this.s.pool.connect.apply(this.s.pool, options.auth);
      // return;
    }

    this.s.pool.connect();
  }

  /**
   * Destroy the server connection
   *
   * @param {Boolean} [options.force=false] Force destroy the pool
   */
  destroy(options: any = {}, callback?: Callback): void {
    if (typeof options === 'function') {
      //(callback = options), (options = {});
      callback = options
      options = {}
    }

    options = { force: options.force || false }
    // options = Object.assign({}, { force: false }, options);

    if (!this.s.pool) {
      this.s.state = STATE_DISCONNECTED;
      if (typeof callback === 'function') {
        callback(null, null);
      }

      return;
    }

    ['close', 'error', 'timeout', 'parseError', 'connect'].forEach((eventName: string): void => {
      this.s.pool.removeAllListeners(eventName);
    });

    if (this.s.monitorId) {
      clearTimeout(this.s.monitorId);
    }

    this.s.pool.destroy(options.force, (err?: Error): void => {
      this.s.state = STATE_DISCONNECTED;
      callback(err);
    });
  }

  /**
   * Immediately schedule monitoring of this server. If there already an
   * attempt being made this will be a no-op.
   */
  monitor(options: {[key:string]: any}= {}): void {
    // options = options || {};

    if (this.s.state !== STATE_CONNECTED || this.s.monitoring) {return;}

    if (this.s.monitorId){ clearTimeout(this.s.monitorId);}

    this.s.monitorFunction(this, options);
  }

   /**
    * Executes a command.
    *
    * Options may include the following fields:
    *   + [serializeFunctions=false]
    *   + [checkKeys=false]
    *   + [fullResult=false]
    *   + [session=null]
    */
  command(ns: string, cmd: {[key:string]: any}, options: any = {}, callback: Callback=noop): void {
    if (typeof options === 'function') {
      // (callback = options), (options = {}), (options = options || {});
      callback = options
      options = {}
    }

    const error: MongoError = basicReadValidations(this, options);

    if (error) {
      return callback(error, null);
    }

    // Clone the options
    // Object.assign({}, options, { wireProtocolCommand: false });
    options = {
      ...options,
      wireProtocolCommand: false
    }

    // Debug log
    if (this.s.logger.isDebug()) {
      const strCmd: string = JSON.stringify({
        ns,
        cmd,
        options: debugOptions(DEBUG_FIELDS, options)
      })

      this.s.logger.debug(`executing command [${strCmd}] against ${this.name}`);
    }

    // error if collation not supported
    if (collationNotSupported(this, cmd)) {
      return callback(new MongoError(`server ${this.name} does not support collation`));
      // return;
    }

    wireProtocol.command(this, ns, cmd, options, callback);
  }

  /**
   * Inserts one or more documents.
   *
   * Options may include the following fields:
   *   + [serializeFunctions=false]
   *   + [checkKeys=false]
   *   + [fullResult=false]
   *   + [session=null]
   */
  insert(ns: string, ops:{[key:string]: any}[], options:any={}, callback: ServerOpCallback  = noop): void {
    executeWriteOperation({ server: this, op: 'insert', ns, ops }, options, callback);
  }

  /**
   * Perform one or more update operations
   *
   * Options may include the following fields:
   *   + [serializeFunctions=false]
   *   + [checkKeys=false]
   *   + [fullResult=false]
   *   + [session=null]
   */
  update(ns: string, ops:{[key:string]: any}[], options: any = {}, callback: ServerOpCallback  = noop): void {
    executeWriteOperation({ server: this, op: 'update', ns, ops }, options, callback);
  }

  /**
   * Perform one or more remove operations
   *
   * Options may include the following fields:
   *   + [serializeFunctions=false]
   *   + [checkKeys=false]
   *   + [fullResult=false]
   *   + [session=null]
   */
  remove(ns: string, ops:{[key:string]: any}[], options: any = {}, callback: ServerOpCallback  = noop): void {
    executeWriteOperation({ server: this, op: 'remove', ns, ops }, options, callback);
  }
}

// Object.defineProperty(Server.prototype, 'clusterTime', {
//   get: function() {
//     return this.s.topology.clusterTime;
//   },
//   set: function(clusterTime) {
//     this.s.topology.clusterTime = clusterTime;
//   }
// });

function basicWriteValidations(server: Server): MongoError {
  if (!server.s.pool) {
    return new MongoError('server instance is not connected');
  }

  if (server.s.pool.isDestroyed()) {
    return new MongoError('server instance pool was destroyed');
  }

  return null;
}

function basicReadValidations(server: Server, options: {[key:string]: any}= {}): MongoError {
  const error: MongoError = basicWriteValidations(server);

  if (error) {
    return error;
  }

  if (options.readPreference && !(options.readPreference instanceof ReadPreference)) {
    return new MongoError('readPreference must be an instance of ReadPreference');
  }

  return null;
}

function executeWriteOperation(args: { [key:string]: any }, options:any = {}, callback: Callback = noop): void {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  // options = options || {};

  // TODO: once we drop Node 4, use destructuring either here or in arguments.
  // const server = args.server;
  // const op = args.op;
  // const ns = args.ns;
  const { server, op, ns}: { [key:string]: any } = args
  const ops: { [key:string]: any }[] = Array.isArray(args.ops) ? args.ops : [args.ops];

  const error: MongoError = basicWriteValidations(server);

  if (error) {
    return callback(error, null);
    // return;
  }

  if (collationNotSupported(server, options)) {
    return callback(new MongoError(`server ${this.name} does not support collation`));
    // return;
  }

  return wireProtocol[op](server, ns, ops, options, callback);
}

function connectEventHandler(server: Server): (_: Pool, connection: Connection) => void {
  return (_: Pool, connection: Connection): void => {
    const ismaster: {[key:string]: any} = connection.ismaster;

    server.s.lastIsMasterMs = connection.lastIsMasterMs;

    if (connection.agreedCompressor) {
      server.s.pool.options.agreedCompressor = connection.agreedCompressor;
    }

    if (connection.zlibCompressionLevel) {
      server.s.pool.options.zlibCompressionLevel = connection.zlibCompressionLevel;
    }

    if (connection.ismaster.$clusterTime) {
      // const $clusterTime = connection.ismaster.$clusterTime;
      // server.s.sclusterTime = $clusterTime;
      server.s.clusterTime = connection.ismaster.$clusterTime;
    }

    // log the connection event if requested
    if (server.s.logger.isInfo()) {
      server.s.logger.info(
        `server ${server.name} connected with ismaster [${JSON.stringify(ismaster)}]`
      );
    }

    // emit an event indicating that our description has changed
    server.emit('descriptionReceived', new ServerDescription(server.description.address, ismaster));

    // we are connected and handshaked (guaranteed by the pool)
    server.s.state = STATE_CONNECTED;

    server.emit('connect', server);
  };
}

function errorEventHandler(server: Server): (err?: Error) => void {
  return (err?: Error): void => {
    if (err) {
      server.emit('error', new MongoNetworkError(err));
    }

    server.emit('close');
  };
}

function parseErrorEventHandler(server: Server): (err?: Error) => void {
  return  (err?: Error): void =>  {
    server.s.state = STATE_DISCONNECTED;

    server.emit('error', new MongoParseError(err));
  };
}

// module.exports = Server;
