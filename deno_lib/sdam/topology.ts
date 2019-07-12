// 'use strict';
// const EventEmitter = require('events');
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
// const ServerDescription = require('./server_description').ServerDescription;
import { ServerType, ServerDescription} from "./server_description.ts"
// const ServerType = require('./server_description').ServerType;
// const TopologyDescription = require('./topology_description').TopologyDescription;
import { TopologyType, TopologyDescription } from "./topology_description.ts"
// const TopologyType = require('./topology_description').TopologyType;
// const monitoring = require('./monitoring');
import * as monitoring from "./monitoring.ts"
// const calculateDurationInMs = require('../utils').calculateDurationInMs;
import { Callback, calculateDurationInMs, noop, relayEvents } from "./../utils.ts"
// const MongoTimeoutError = require('../error').MongoTimeoutError;
import { MongoError, MongoParseError, MongoTimeoutError, isRetryableError} from "./../errors.ts"
// const Server = require('./server');
import { Server} from "./server.ts"
// const relayEvents = require('../utils').relayEvents;
// const ReadPreference = require('../topologies/read_preference');
import { ReadPreference } from "./../topologies/read_preference.ts"
// const readPreferenceServerSelector = require('./server_selectors').readPreferenceServerSelector;
import { readPreferenceServerSelector, writableServerSelector} from "./server_selectors.ts"
// const writableServerSelector = require('./server_selectors').writableServerSelector;
// const isRetryableWritesSupported = require('../topologies/shared').isRetryableWritesSupported;
import { createClientInfo,createCompressionInfo, isRetryableWritesSupported,resolveClusterTime} from "./../topologies/shared.ts"
// const Cursor = require('../cursor');
import { Pool } from "./../connection/pool.ts"
import { Connection } from "./../connection/connection.ts"
import { CommandResult } from "./../connection/command_result.ts"
import { Cursor } from "./../cursor.ts"
// const deprecate = require('util').deprecate;
// const BSON = require('../connection/utils').retrieveBSON();
// const createCompressionInfo = require('../topologies/shared').createCompressionInfo;
// const isRetryableError = require('../error').isRetryableError;
// const MongoParseError = require('../error').MongoParseError;
// const ClientSession = require('../sessions').ClientSession;
import {ClientSession} from "./../sessions.ts"
// const createClientInfo = require('../topologies/shared').createClientInfo;
// const MongoError = require('../error').MongoError;
// const resolveClusterTime = require('../topologies/shared').resolveClusterTime;

// Global state
let globalTopologyCounter: number = 0;

// Constants
const TOPOLOGY_DEFAULTS: {[key:string]: number} = {
  localThresholdMS: 15,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 30000,
  minHeartbeatFrequencyMS: 500
};

// events that we relay to the `Topology`
const SERVER_RELAY_EVENTS: string[] = [
  'serverHeartbeatStarted',
  'serverHeartbeatSucceeded',
  'serverHeartbeatFailed',
  'commandStarted',
  'commandSucceeded',
  'commandFailed',

  // NOTE: Legacy events
  'monitoring'
];

// all events we listen to from `Server` instances
const LOCAL_SERVER_EVENTS: string[] = SERVER_RELAY_EVENTS.concat([
  'error',
  'connect',
  'descriptionReceived',
  'close',
  'ended'
]);

// server state connecting constant
const STATE_CONNECTING: number = 1;

export interface TopologyOptions {
  host?: string;
  port?: number
  localThresholdMS?: number;
  serverSelectionTimeoutMS?: number;
  heartbeatFrequencyMS?: number;
  minHeartbeatFrequencyMS?:number;
  replicaSet?: unknown
  minHeartbeatIntervalMS?: number
  cursorFactory?: unknown
  credentials?: unknown
  compression?: {
    compressors?: unknown
  };
}

/**
 * A container of server instances representing a connection to a MongoDB topology.
 *
 * @fires Topology#serverOpening
 * @fires Topology#serverClosed
 * @fires Topology#serverDescriptionChanged
 * @fires Topology#topologyOpening
 * @fires Topology#topologyClosed
 * @fires Topology#topologyDescriptionChanged
 * @fires Topology#serverHeartbeatStarted
 * @fires Topology#serverHeartbeatSucceeded
 * @fires Topology#serverHeartbeatFailed
 */
export class Topology extends EventEmitter {
  readonly s: {
    // the id of this topology
    id: number;
    // passed in options
    options: TopologyOptions
    // initial seedlist of servers to connect to
    seedlist: string[]
    // the topology description
    description:  TopologyDescription,
    serverSelectionTimeoutMS: number
    heartbeatFrequencyMS: number
    minHeartbeatIntervalMS: number
    // allow users to override the cursor factory
    Cursor: Cursor,
    // the bson parser
    // bson: options.bson || new BSON(),
    // a map of server instances to normalized addresses
    servers: Map<string,Server>
    // Server Session Pool
    sessionPool: Pool
    // Active client sessions
    sessions: Session[],
    // Promise library
    // promiseLibrary: options.promiseLibrary || Promise,
    credentials: MongoCredentials
    clusterTime: unknown
    clientInfo: unknown
    connected: boolean
  }
  // /**
  //  * Create a topology
  //  *
  //  * @param {Array|String} [seedlist] a string list, or array of Server instances to connect to
  //  * @param {Object} [options] Optional settings
  //  * @param {Number} [options.localThresholdMS=15] The size of the latency window for selecting among multiple suitable servers
  //  * @param {Number} [options.serverSelectionTimeoutMS=30000] How long to block for server selection before throwing an error
  //  * @param {Number} [options.heartbeatFrequencyMS=10000] The frequency with which topology updates are scheduled
  //  */

  constructor(seedlist: any = [], options: TopologyOptions = {}) {
    super();

    // if (typeof options === 'undefined' && typeof seedlist !== 'string') {
    if (seedlist.constructor === Object) {
      options = seedlist;
      seedlist = [];

      // this is for legacy single server constructor support
      if (options.host) {
        seedlist.push({ host: options.host, port: options.port });
      }
    }

    // seedlist = seedlist || [];
    if (typeof seedlist === 'string') {
      seedlist = parseStringSeedlist(seedlist);
    }

    // options = Object.assign({}, TOPOLOGY_DEFAULTS, options);
    options = { ...TOPOLOGY_DEFAULTS, ...options}

    const topologyType: string = topologyTypeFromSeedlist(seedlist, options);
    const topologyId: number = globalTopologyCounter++;

    const serverDescriptions:Map<string, ServerDescription> = seedlist.reduce((result:Map<string, ServerDescription>, seed: ServerDescription):Map<string, ServerDescription> => {
      if (seed.domain_socket) {seed.host = seed.domain_socket;}

      const address: string = seed.port ? `${seed.host}:${seed.port}` : `${seed.host}:27017`;

      result.set(address, new ServerDescription(address));

      return result;
    }, new Map<string, ServerDescription>());

    this.s = {
      // the id of this topology
      id: topologyId,
      // passed in options
      options,
      // initial seedlist of servers to connect to
      seedlist: seedlist,
      // the topology description
      description: new TopologyDescription(
        topologyType,
        serverDescriptions,
        options.replicaSet,
        null,
        null,
        null,
        options
      ),
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
      heartbeatFrequencyMS: options.heartbeatFrequencyMS,
      minHeartbeatIntervalMS: options.minHeartbeatIntervalMS,
      // allow users to override the cursor factory
      Cursor: options.cursorFactory || Cursor,
      // the bson parser
      // bson: options.bson || new BSON(),
      // a map of server instances to normalized addresses
      servers: new Map<string, Server>(),
      // Server Session Pool
      sessionPool: null,
      // Active client sessions
      sessions: [],
      // Promise library
      // promiseLibrary: options.promiseLibrary || Promise,
      credentials: options.credentials,
      clusterTime: null,
      clientInfo: null,
      connected: false
    };

    // amend options for server instance creation
    this.s.options.compression = { compressors: createCompressionInfo(options) };

    // add client info
    this.s.clientInfo = createClientInfo(options);
  }

  /** A `TopologyDescription` for this topology. */
  get description(): TopologyDescription {
    return this.s.description;
  }

  // get parserType() {
  //   return BSON.native ? 'c++' : 'js';
  // }

  /**
   * All raw connections
   * @method
   * @return {Connection[]}
   */
  connections(): Connection[] {
    return Array.from(this.s.servers.values()).reduce((result:Connection[], server: Server):Connection[] => {
      return result.concat(server.s.pool.allConnections());
    }, []);
  }

  /**
   * Initiate server connect
   *
   * @param {Object} [options] Optional settings
   * @param {Array} [options.auth=null] Array of auth options to apply on connect
   * @param {function} [callback] An optional callback called once on the first connected server
   */
  connect(options: any = {}, callback: Callback= noop): void {
    // if (typeof options === 'function') (callback = options), (options = {});
    if (typeof options === 'function') {
      callback = options
      options = {}
    }

    // options = options || {};

    // emit SDAM monitoring events
    this.emit('topologyOpening', new monitoring.TopologyOpeningEvent(this.s.id));

    // emit an event for the topology change
    this.emit(
      'topologyDescriptionChanged',
      new monitoring.TopologyDescriptionChangedEvent(
        this.s.id,
        new TopologyDescription(TopologyType.Unknown), // initial is always Unknown
        this.s.description
      )
    );

    connectServers(this, Array.from(this.s.description.servers.values()));

    this.s.connected = true;

    // otherwise, wait for a server to properly connect based on user provided read preference,
    // or primary.

    translateReadPreference(options);

    const readPreference: ReadPreference = options.readPreference || ReadPreference.primary;

    this.selectServer(readPreferenceServerSelector(readPreference), options, (err?: Error, server?: Server): void => {
      if (err) {
        // if (typeof callback === 'function') {
        //   callback(err, null);
        // } else {
        //   this.emit('error', err);
        // }
        //
        // return;
        return this.emit('error', err);
      }

      const errorHandler: (err? :Error) => void = (err?:Error): void => {
        server.removeListener('connect', connectHandler);
        // if (typeof callback === 'function') callback(err, null);
        callback(err, null);
      };

      const connectHandler: (_?: unknown, err?: Error)=> void = (_?: unknown, err?: Error): void => {
        server.removeListener('error', errorHandler);
        this.emit('open', err, this);
        this.emit('connect', this);
        // if (typeof callback === 'function') callback(err, this);
        callback(err, this);
      };

      // const STATE_CONNECTING: number = 1;
      if (server.s.state === STATE_CONNECTING) {
        server.once('error', errorHandler);
        server.once('connect', connectHandler);
        return;
      }

      connectHandler();
    });
  }

  /**
   * Close this topology
   */
  close(options: any = {}, callback: Callback = noop): void {
    // if (typeof options === 'function') (callback = options), (options = {});
        if (typeof options === 'function') {
          callback = options
          options = {}
        }
    // options = options || {};

    if (this.s.sessionPool) {
      this.s.sessions.forEach(session => session.endSession());
      this.s.sessionPool.endAllPooledSessions();
    }

    const servers: Map<string, Server> = this.s.servers;

    if (servers.size === 0) {
      this.s.connected = false;

      // if (typeof callback === 'function') {
      //   callback(null, null);
      // }

      return  callback(null, null);

      // return;
    }

    // destroy all child servers
    let destroyed: number = 0;

    servers.forEach((server: Server): void =>
      destroyServer(server, this, (): void => {
        // destroyed++;

        if (++destroyed === servers.size) {
          // emit an event for close
          this.emit('topologyClosed', new monitoring.TopologyClosedEvent(this.s.id));

          this.s.connected = false;
          // if (typeof callback === 'function') {
          //   callback(null, null);
          // }
          callback(null, null);
        }
      })
    );
  }

  /**
   * Selects a server according to the selection predicate provided
   *
   * @param {function} [selector] An optional selector to select servers by, defaults to a random selection within a latency window
   * @param {object} [options] Optional settings related to server selection
   * @param {number} [options.serverSelectionTimeoutMS] How long to block for server selection before throwing an error
   * @param {function} callback The callback used to indicate success or failure
   * @return {Server} An instance of a `Server` meeting the criteria of the predicate provided
   */
  selectServer(selector: Function, options: any = {}, callback: Callback = noop): void {
    if (typeof options === 'function') {
      callback = options;

      if (typeof selector !== 'function') {
        options = selector;

        translateReadPreference(options);

        const readPreference: ReadPreference = options.readPreference || ReadPreference.primary;

        selector = readPreferenceServerSelector(readPreference);
      } else {
        options = {};
      }
    }

    options = {
      serverSelectionTimeoutMS: this.s.serverSelectionTimeoutMS,
      ...options
    }
    // Object.assign(
    //   {},
    //   { serverSelectionTimeoutMS: this.s.serverSelectionTimeoutMS },
    //   options
    // );

    const isSharded: boolean = this.description.type === TopologyType.Sharded;
    const session: Session = options.session;
    const transaction: Transaction = session && session.transaction;

    if (isSharded && transaction && transaction.server) {
      return callback(null, transaction.server);
      // return;
    }

    selectServers(
      this,
      selector,
      options.serverSelectionTimeoutMS,
       // process.hrtime(),
       performance.now(),
      (err?: Error, servers?: Server[]): void => {
        if (err) {
          return callback(err, null);
        }

        const selectedServer: Server = randomSelection(servers);

        if (isSharded && transaction && transaction.isActive) {
          transaction.pinServer(selectedServer);
        }

        callback(null, selectedServer);
      }
    );
  }

  // Sessions related methods
  /** Whether sessions are supported on the current topology? */
  hasSessionSupport(): boolean {
    return !!this.description.logicalSessionTimeoutMinutes;
  }

  /** Start a logical session. */
  startSession(options: {[key:string]:any} = {}, clientOptions: {[key:string]:any} = {}): Session[] {
    const session: Session = new ClientSession(this, this.s.sessionPool, options, clientOptions);

    session.once('ended', (): void => {
      this.s.sessions = this.s.sessions.filter((s: Session): boolean => !s.equals(session));
    });

    this.s.sessions.push(session);

    return session;
  }

  /** Send endSessions command(s) with the given session ids. */
  endSessions(sessions: Session[], callback: Callback = noop): void {
    if (!Array.isArray(sessions)) {
      sessions = [sessions];
    }

    this.command(
      'admin.$cmd',
      { endSessions: sessions },
      { readPreference: ReadPreference.primaryPreferred, noResponse: true },
      ():void => {
        // intentionally ignored, per spec
        // if (typeof callback === 'function') callback();
        callback(null, null);
      }
    );
  }

  /**
   * Update the internal TopologyDescription with a ServerDescription
   *
   * @param {object} serverDescription The server to update in the internal list of server descriptions
   */
  serverUpdateHandler(serverDescription: ServerDescription): void {
    if (!this.s.description.hasServer(serverDescription.address)) {
      return;
    }

    // these will be used for monitoring events later
    const previousTopologyDescription: TopologyDescription = this.s.description;
    const previousServerDescription: ServerDescription = this.s.description.servers.get(serverDescription.address);

    // first update the TopologyDescription
    this.s.description = this.s.description.update(serverDescription);

    if (this.s.description.compatibilityError) {
    return   this.emit('error', new MongoError(this.s.description.compatibilityError));
      // return;
    }

    // emit monitoring events for this change
    this.emit(
      'serverDescriptionChanged',
      new monitoring.ServerDescriptionChangedEvent(
        this.s.id,
        serverDescription.address,
        previousServerDescription,
        this.s.description.servers.get(serverDescription.address)
      )
    );

    // update server list from updated descriptions
    updateServers(this, serverDescription);

    // Driver Sessions Spec: "Whenever a driver receives a cluster time from
    // a server it MUST compare it to the current highest seen cluster time
    // for the deployment. If the new cluster time is higher than the
    // highest seen cluster time it MUST become the new highest seen cluster
    // time. Two cluster times are compared using only the BsonTimestamp
    // value of the clusterTime embedded field."
    const clusterTime: unknown = serverDescription.$clusterTime;

    if (clusterTime) {
      resolveClusterTime(this, clusterTime);
    }

    this.emit(
      'topologyDescriptionChanged',
      new monitoring.TopologyDescriptionChangedEvent(
        this.s.id,
        previousTopologyDescription,
        this.s.description
      )
    );
  }

  auth(credentials?: MongoCredentials, callback: Callback=noop): void {
            // this.s.logger.warn("Topology.prototype.auth is a noop method")
    // if (typeof credentials === 'function') (callback = credentials), (credentials = null);
    // if (typeof callback === 'function') callback(null, true);
    callback(null, true)
  }

  logout(callback: Callback = noop): void {
    // if (typeof callback === 'function') callback(null, true);
    callback(null, true)
  }

  // Basic operation support. Eventually this should be moved into command construction
  // during the command refactor.

  /**
   * Insert one or more documents
   *
   * @param {String} ns The full qualified namespace for this operation
   * @param {Array} ops An array of documents to insert
   * @param {Boolean} [options.ordered=true] Execute in order or out of order
   * @param {Object} [options.writeConcern] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields
   * @param {ClientSession} [options.session] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  insert(ns: string, ops:{[key:string]:any}[], options: {[key:string]:any}, callback:Callback =noop): void {
    executeWriteOperation({ topology: this, op: 'insert', ns, ops }, options, callback);
  }

  /**
   * Perform one or more update operations
   *
   * @param {string} ns The fully qualified namespace for this operation
   * @param {array} ops An array of updates
   * @param {boolean} [options.ordered=true] Execute in order or out of order
   * @param {object} [options.writeConcern] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields
   * @param {ClientSession} [options.session] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  update(ns: string, ops:{[key:string]:any}[], options: {[key:string]:any}, callback:Callback=noop): void {
    executeWriteOperation({ topology: this, op: 'update', ns, ops }, options, callback);
  }

  /**
   * Perform one or more remove operations
   *
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {array} ops An array of removes
   * @param {boolean} [options.ordered=true] Execute in order or out of order
   * @param {object} [options.writeConcern={}] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  remove(ns: string, ops: {[key:string]:any}[], options: {[key:string]:any}, callback:Callback=noop):void {
    executeWriteOperation({ topology: this, op: 'remove', ns, ops }, options, callback);
  }

  /**
   * Execute a command
   *
   * @method
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {object} cmd The command hash
   * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
   * @param {Connection} [options.connection] Specify connection object to execute command against
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {opResultCallback} callback A callback function
   */
  command(ns:string, cmd: {[key:string]:any}, options: any={}, callback:Callback=noop):void {
    if (typeof options === 'function') {
      // (callback = options), (options = {}), (options = options || {});
      callback = options
      options = {}
    }

    translateReadPreference(options);

    const readPreference:ReadPreference = options.readPreference || ReadPreference.primary;

    this.selectServer(readPreferenceServerSelector(readPreference), options, (err?: Error, server?:Server): void => {
      if (err) {
      return  callback(err, null);
        // return;
      }

      const willRetryWrite: boolean =
        !options.retrying &&
        !!options.retryWrites &&
        options.session &&
        isRetryableWritesSupported(this) &&
        !options.session.inTransaction() &&
        isWriteCommand(cmd);

      const cb: Callback = (err?: Error, result?:CommandResult): any => {
        if (!err){ return callback(null, result);}

        if (!isRetryableError(err)) {
          return callback(err);
        }

        if (willRetryWrite) {
          // const newOptions = Object.assign({}, options, { retrying: true });
          const newOptions: {[key:string]: any} = { ...options, retrying:true}
          return this.command(ns, cmd, newOptions, callback);
        }

        return callback(err);
      };

      // increment and assign txnNumber
      if (willRetryWrite) {
        options.session.incrementTransactionNumber();
        options.willRetryWrite = willRetryWrite;
      }

      server.command(ns, cmd, options, cb);
    });
  }

  /**
   * Create a new cursor
   *
   * @method
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {object|Long} cmd Can be either a command returning a cursor or a cursorId
   * @param {object} [options] Options for the cursor
   * @param {object} [options.batchSize=0] Batchsize for the operation
   * @param {array} [options.documents=[]] Initial documents list for cursor
   * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {object} [options.topology] The internal topology of the created cursor
   * @returns {Cursor}
   */
  cursor(ns: string, cmd:{[key:string]:any}, options:{[key:string]:any}): CursorClass {
    options = options || {};
    const topology = options.topology || this;
    const CursorClass = options.cursorFactory || this.s.Cursor;
    translateReadPreference(options);

    return new CursorClass(/*this.s.bson, */ns, cmd, options, topology, this.s.options);
  }

  get clientInfo(): unknown {
    return this.s.clientInfo;
  }

  // // Legacy methods for compat with old topology types
  // isConnected(): boolean {
  //   // console.log('not implemented: `isConnected`');
  //   return true;
  // }
  //
  // isDestroyed() {
  //   // console.log('not implemented: `isDestroyed`');
  //   return false;
  // }

  // unref() {
  //   console.log('not implemented: `unref`');
  // }

  // NOTE: There are many places in code where we explicitly check the last isMaster
  //       to do feature support detection. This should be done any other way, but for
  //       now we will just return the first isMaster seen, which should suffice.
  lastIsMaster(): ServerDescription | {maxWireVersion: number} {
    const serverDescriptions:ServerDescription[] = Array.from(this.description.servers.values());

    if (serverDescriptions.length === 0) {return {};}

    const sd:ServerDescription = serverDescriptions.filter((sd:ServerDescription): boolean => sd.type !== ServerType.Unknown)[0];

    const result: ServerDescription | {maxWireVersion: number} = sd || { maxWireVersion: this.description.commonWireVersion };

    return result;
  }

  get logicalSessionTimeoutMinutes(): number {
    return this.description.logicalSessionTimeoutMinutes;
  }

  // get bson() {
  //   return this.s.bson;
  // }
}

Object.defineProperty(Topology.prototype, 'clusterTime', {
  enumerable: true,
  get(): unknown {
    return this.s.clusterTime;
  },
  set(clusterTime: unknown): void {
    this.s.clusterTime = clusterTime;
  }
});

// // legacy aliases
// Topology.prototype.destroy = deprecate(
//   Topology.prototype.close,
//   'destroy() is deprecated, please use close() instead'
// );

const RETRYABLE_WRITE_OPERATIONS: string[] = ['findAndModify', 'insert', 'update', 'delete'];

function isWriteCommand(command: {[key:string]: any}): boolean {
  return RETRYABLE_WRITE_OPERATIONS.some((op: string): boolean => command[op]);
}

/**
 * Destroys a server, and removes all event listeners from the instance
 *
 * @param {Server} server
 */
function destroyServer(server: Server, topology: Topology, callback:Callback=noop): void {
  LOCAL_SERVER_EVENTS.forEach((eventName: string): void => server.removeAllListeners(eventName));

  server.destroy((): void => {
    topology.emit(
      'serverClosed',
      new monitoring.ServerClosedEvent(topology.s.id, server.description.address)
    );

    // if (typeof callback === 'function') callback(null, null);
    callback(null, null);
  });
}

/**
 * Parses a basic seedlist in string form
 *
 * @param {string} seedlist The seedlist to parse
 */
function parseStringSeedlist(seedlist: string): { host: string, port: number}[] {
  return seedlist.split(',').map((seed: string): { host: string, port: number}=> ({
    host: seed.split(':')[0],
    port: Number(seed.split(':')[1]) || 27017
  }));
}

function topologyTypeFromSeedlist(seedlist: string, options: {[key:string]: any} = {}): string {
  const replicaSet: any = options.replicaSet || options.setName || options.rs_name;

  if (seedlist.length === 1 && !replicaSet){
     return TopologyType.Single;
  }

  if (replicaSet){
     return TopologyType.ReplicaSetNoPrimary;
  }

  return TopologyType.Unknown;
}

function randomSelection(arr: any[]): any {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Selects servers using the provided selector
 *
 * @private
 * @param {Topology} topology The topology to select servers from
 * @param {function} selector The actual predicate used for selecting servers
 * @param {Number} timeout The max time we are willing wait for selection
 * @param {Number} start A high precision timestamp for the start of the selection process
 * @param {function} callback The callback used to convey errors or the resultant servers
 */
function selectServers(topology: Topology, selector: any, timeout: number, start: number, callback: Callback= noop): void {
  const duration: number = calculateDurationInMs(start);

  if (duration >= timeout) {
    return callback(new MongoTimeoutError(`Server selection timed out after ${timeout} ms`));
  }

  // ensure we are connected
  if (!topology.s.connected) {
    topology.connect();

    // we want to make sure we're still within the requested timeout window
    const failToConnectTimer: number = setTimeout((): void => {
      topology.removeListener('connect', connectHandler);
      callback(new MongoTimeoutError('Server selection timed out waiting to connect'));
    }, timeout - duration);

    const connectHandler: () => void = (): void => {
      clearTimeout(failToConnectTimer);
      selectServers(topology, selector, timeout, performance.now()/*process.hrtime()*/, callback);
    };

    return topology.once('connect', connectHandler);
    // return;
  }

  // otherwise, attempt server selection
  const serverDescriptions: ServerDescription[] = Array.from(topology.description.servers.values());

  let descriptions: ServerDescription[];

  // support server selection by options with readPreference
  if (typeof selector === 'object') {
    const readPreference: ReadPreference = selector.readPreference
      ? selector.readPreference
      : ReadPreference.primary;

    selector = readPreferenceServerSelector(readPreference);
  }

  try {
    descriptions = selector
      ? selector(topology.description, serverDescriptions)
      : serverDescriptions;
  } catch (err) {
    return callback(err, null);
  }

  if (descriptions.length) {
    const servers: Server[] = descriptions.map((description: ServerDescription): Server => topology.s.servers.get(description.address));

    return callback(null, servers);
  }

  const retrySelection: () => void = (): void => {
    // ensure all server monitors attempt monitoring soon
    topology.s.servers.forEach((server: ServerDescription): void => {
      setTimeout(
        (): void => server.monitor({ heartbeatFrequencyMS: topology.description.heartbeatFrequencyMS }),
        TOPOLOGY_DEFAULTS.minHeartbeatFrequencyMS
      );
    });

    const descriptionChangedHandler: () => void = (): void => {
      // successful iteration, clear the check timer
      clearTimeout(iterationTimer);

      if (topology.description.error) {
      return  callback(topology.description.error, null);
        // return;
      }

      // topology description has changed due to monitoring, reattempt server selection
      selectServers(topology, selector, timeout, start, callback);
    };

    const iterationTimer: number = setTimeout((): void => {
      topology.removeListener('topologyDescriptionChanged', descriptionChangedHandler);

      callback(new MongoTimeoutError(`Server selection timed out after ${timeout} ms`));
    }, timeout - duration);

    topology.once('topologyDescriptionChanged', descriptionChangedHandler);
  };

  retrySelection();
}

function createAndConnectServer(topology: Topology, serverDescription: ServerDescription): void {
  topology.emit(
    'serverOpening',
    new monitoring.ServerOpeningEvent(topology.s.id, serverDescription.address)
  );

  const server: Server = new Server(serverDescription, topology.s.options, topology);

  relayEvents(server, topology, SERVER_RELAY_EVENTS);

  server.once('connect', serverConnectEventHandler(server, topology));
  server.on('descriptionReceived', topology.serverUpdateHandler.bind(topology));
  server.on('error', serverErrorEventHandler(server, topology));
  server.on('close', ():void => topology.emit('close', server));
  server.connect();

  return server;
}

/**
 * Create `Server` instances for all initially known servers, connect them, and assign
 * them to the passed in `Topology`.
 *
 * @param {Topology} topology The topology responsible for the servers
 * @param {ServerDescription[]} serverDescriptions A list of server descriptions to connect
 */
function connectServers(topology: Topology, serverDescriptions: ServerDescription[]): void {
  topology.s.servers = serverDescriptions.reduce((servers, serverDescription) => {
    const server: Server = createAndConnectServer(topology, serverDescription);
    servers.set(serverDescription.address, server);
    return servers;
  }, new Map<string, Server>());
}

function updateServers(topology: Topology, incomingServerDescription: ServerDescription): void {
  // update the internal server's description
  if (topology.s.servers.has(incomingServerDescription.address)) {
    const server: Server = topology.s.servers.get(incomingServerDescription.address);
    server.s.description = incomingServerDescription;
  }

  // add new servers for all descriptions we currently don't know about locally
  for (const serverDescription of topology.description.servers.values()) {
    if (!topology.s.servers.has(serverDescription.address)) {
      const server: Server = createAndConnectServer(topology, serverDescription);
      topology.s.servers.set(serverDescription.address, server);
    }
  }

  // for all servers no longer known, remove their descriptions and destroy their instances
  for (const entry of topology.s.servers) {
    const serverAddress: string = entry[0];

    if (topology.description.hasServer(serverAddress)) {
      continue;
    }

    const server: Server = topology.s.servers.get(serverAddress);

    topology.s.servers.delete(serverAddress);

    // prepare server for garbage collection
    destroyServer(server, topology);
  }
}

function serverConnectEventHandler(server: Server, topology: Topology): () => void {
  return function(/* isMaster, err */) {
    server.monitor({
      initial: true,
      heartbeatFrequencyMS: topology.description.heartbeatFrequencyMS
    });
  };
}

function serverErrorEventHandler(server: Server, topology: Topology): (err?: Error) => void {
  return function(err?: Error): void {
    topology.emit(
      'serverClosed',
      new monitoring.ServerClosedEvent(topology.s.id, server.description.address)
    );

    if (err instanceof MongoParseError) {
    return  resetServerState(server, err, { clearPool: true });
      // return;
    }

    resetServerState(server, err);
  };
}

function executeWriteOperation(args:{[key:string]: any}, options:any={}, callback:Callback=noop): void {
  // if (typeof options === 'function') (callback = options), (options = {});
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  // options = options || {};

  // TODO: once we drop Node 4, use destructuring either here or in arguments.
  const topology: Topology = args.topology;
  const op: string = args.op;
  const ns: string = args.ns;
  const ops:{[key:string]: any}[] = args.ops;

  const willRetryWrite: boolean =
    !args.retrying &&
    !!options.retryWrites &&
    options.session &&
    isRetryableWritesSupported(topology) &&
    !options.session.inTransaction();

  topology.selectServer(writableServerSelector(), options, (err?: Error, server?: Server): void => {
    if (err) {
      return callback(err, null);
      // return;
    }

    const handler:{(err?:Error, result?: CommandResult) : void, operationId: number} = (err?:Error, result?: CommandResult): void => {
      if (!err) {return callback(null, result);}

      if (!isRetryableError(err)) {
        return callback(err);
      }

      if (willRetryWrite) {
        // const newArgs: {[key:string]: any} = Object.assign({}, args, { retrying: true });
        const newArgs: {[key:string]: any} = { ...args, retrying: true }
        return executeWriteOperation(newArgs, options, callback);
      }

      return callback(err);
    };

    if (callback.operationId) {
      handler.operationId = callback.operationId;
    }

    // increment and assign txnNumber
    if (willRetryWrite) {
      options.session.incrementTransactionNumber();
      options.willRetryWrite = willRetryWrite;
    }

    // execute the write operation
    server[op](ns, ops, options, handler);
  });
}

/**
 * Resets the internal state of this server to `Unknown` by simulating an empty ismaster
 *
 * @private
 * @param {Server} server
 * @param {MongoError} error The error that caused the state reset
 * @param {object} [options] Optional settings
 * @param {boolean} [options.clearPool=false] Pool should be cleared out on state reset
 */
function resetServerState(server: Server, error: Error, options:{[key:string]:any} = {}) {
  // options = Object.assign({}, { clearPool: false }, options);
    options = { clearPool: false, ...options}

  function resetState(): void {
    server.emit(
      'descriptionReceived',
      new ServerDescription(server.description.address, null, { error })
    );
  }

  if (options.clearPool && server.pool) {
    return server.pool.reset(resetState);
    // return;
  }

  resetState();
}

function translateReadPreference(options:{[key:string]: any}):{[key:string]: any} {
  if (!options.readPreference) {
    return;
  }

  let r:any = options.readPreference;

  if (typeof r === 'string') {
    options.readPreference = new ReadPreference(r);
  } else if (r && !(r instanceof ReadPreference) && typeof r === 'object') {
    const mode:unknown = r.mode || r.preference;

    if (mode && typeof mode === 'string') {
      options.readPreference = new ReadPreference(mode, r.tags, {
        maxStalenessSeconds: r.maxStalenessSeconds
      });
    }
  } else if (!(r instanceof ReadPreference)) {
    throw new TypeError('Invalid read preference: ' + r);
  }

  return options;
}

/**
 * A server opening SDAM monitoring event
 *
 * @event Topology#serverOpening
 * @type {ServerOpeningEvent}
 */

/**
 * A server closed SDAM monitoring event
 *
 * @event Topology#serverClosed
 * @type {ServerClosedEvent}
 */

/**
 * A server description SDAM change monitoring event
 *
 * @event Topology#serverDescriptionChanged
 * @type {ServerDescriptionChangedEvent}
 */

/**
 * A topology open SDAM event
 *
 * @event Topology#topologyOpening
 * @type {TopologyOpeningEvent}
 */

/**
 * A topology closed SDAM event
 *
 * @event Topology#topologyClosed
 * @type {TopologyClosedEvent}
 */

/**
 * A topology structure SDAM change event
 *
 * @event Topology#topologyDescriptionChanged
 * @type {TopologyDescriptionChangedEvent}
 */

/**
 * A topology serverHeartbeatStarted SDAM event
 *
 * @event Topology#serverHeartbeatStarted
 * @type {ServerHeartbeatStartedEvent}
 */

/**
 * A topology serverHeartbeatFailed SDAM event
 *
 * @event Topology#serverHeartbeatFailed
 * @type {ServerHearbeatFailedEvent}
 */

/**
 * A topology serverHeartbeatSucceeded SDAM change event
 *
 * @event Topology#serverHeartbeatSucceeded
 * @type {ServerHeartbeatSucceededEvent}
 */

/**
 * An event emitted indicating a command was started, if command monitoring is enabled
 *
 * @event Topology#commandStarted
 * @type {object}
 */

/**
 * An event emitted indicating a command succeeded, if command monitoring is enabled
 *
 * @event Topology#commandSucceeded
 * @type {object}
 */

/**
 * An event emitted indicating a command failed, if command monitoring is enabled
 *
 * @event Topology#commandFailed
 * @type {object}
 */

// module.exports = Topology;
