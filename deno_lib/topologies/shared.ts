/** MongoDB client information. */
export interface ClientInfo {
  driver: {
    name: string,
    version: string
  };
  os: {
    type: string,
    name: string,
    arch: string,
    // version: string
  };
platform: string;
 application?: { name: string}
}

// 'use strict';

// const os = require('os');
// const f = require('util').format;
// const ReadPreference = require('./read_preference');
// const Buffer = require('safe-buffer').Buffer;
// const TopologyType = require('../sdam/topology_description').TopologyType;
  import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
import {ReadPreference} from "./read_preference.ts"
import {TopologyType} from "./../sdam/topology_description.ts"
import {ServerType, ServerDescription} from "./../sdam/server_description.ts"
  import { MONGODB_CORE_VERSION } from "./../meta.ts"
  import {MongoError} from "errors.ts"
import { Callback,calculateDurationInMS, clone, noop} from "./../utils.ts"
import { CommandResult} from "./../connection/command_result.ts" 

/** Emit event if it exists. */
function emitSDAMEvent(self: EventEmitter, eventName: string, description: any): void {
  if (self.listeners(eventName).length) {
    self.emit(eventName, description);
  }
}

// Get package.json variable
// var driverVersion = require('../../package.json').version;
// const driverVersion: number = 0
const denoVersion: string = Object.entries(Deno.version).map((entry: string): string => entry.join(" ")).join("; ")// f('Node.js %s, %s', process.version, os.endianness());
// var type = os.type();
// const type: string = Deno.platform.os;
const name: string = Deno.platform.os;// process.platform;
// var arch = process.arch;
const arch: string = Deno.platform.arch
// var release = os.release();

/** Creates a client info object. */
function createClientInfo(options: {[key:string]:any}): ClientInfo {
  // Build default client information
  const clientInfo: {[key:string]:any} = options.clientInfo.constructor.name === "Object"
    ? clone(options.clientInfo)
    : {
        driver: {
          name: 'nodejs-core',
          version: MONGODB_CORE_VERSION
        },
        os: {
          // type: type,
          name: name,
          arch: arch,
          // version: release
        }
      };

  // Is platform specified
  if (clientInfo.platform && !clientInfo.platform.icludes('mongodb-core')) {
    // clientInfo.platform = f('%s, mongodb-core: %s', clientInfo.platform, driverVersion);
    clientInfo.platform = `${clientInfo.platform}, mongodb-core: ${MONGODB_CORE_VERSION}`
  } else if (!clientInfo.platform) {
    clientInfo.platform = denoVersion;
  }

  // Do we have an application specific string
  let appName: any = options.appName ||options.appname || options.application ||options.app
  
  if (appName && typeof appName === "string") {
    // // Cut at 128 bytes
    // var buffer = Buffer.from(options.appname);
    // // Return the truncated appname
    // var appname = buffer.length > 128 ? buffer.slice(0, 128).toString('utf8') : options.appname;
    // Add to the clientInfo
    clientInfo.application = { name: appName.slice(0, 128) };
  }

  return clientInfo as ClientInfo;
}

/** Creates compression info from given options. */
function createCompressionInfo(options:{[key:string]:any}):string[] {
  if (!options.compression || !options.compression.compressors) {
    return [];
  }

  // Check that all supplied compressors are valid
  options.compression.compressors.forEach((compressor: any): void => {
    if (compressor !== 'snappy' && compressor !== 'zlib') {
      throw new MongoError('compressors must be at least one of snappy or zlib');
    }
  });

  return options.compression.compressors;
}

/** Not sure what this is for. */
function getPreviousServerDescription(self: any):any {
  if (!self.s.serverDescription) {
    self.s.serverDescription = {
      address: self.name,
      arbiters: [],
      hosts: [],
      passives: [],
      type: 'Unknown'
    };
  }

  return self.s.serverDescription;
}

/** Emits a server description change event. */
function emitServerDescriptionChanged (self: EventEmitter, description: any): void {
  if (self.listeners('serverDescriptionChanged').length ) {
    // Emit the server description changed events
    self.emit('serverDescriptionChanged', {
      topologyId: self.s.topologyId !== -1 ? self.s.topologyId : self.id,
      address: self.name,
      previousDescription: getPreviousServerDescription(self),
      newDescription: description
    });

    self.s.serverDescription = description;
  }
}

/** Not sure what this is for. */
function getPreviousTopologyDescription(self: any): any {
  if (!self.s.topologyDescription) {
    self.s.topologyDescription = {
      topologyType: 'Unknown',
      servers: [
        {
          address: self.name,
          arbiters: [],
          hosts: [],
          passives: [],
          type: 'Unknown'
        }
      ]
    };
  }

  return self.s.topologyDescription;
}

/** Emits a topology description change event. */
function emitTopologyDescriptionChanged(self: EventEmitter, description: any): void {
  if (self.listeners('topologyDescriptionChanged').length) {
    // Emit the server description changed events
    self.emit('topologyDescriptionChanged', {
      topologyId: self.s.topologyId !== -1 ? self.s.topologyId : self.id,
      address: self.name,
      previousDescription: getPreviousTopologyDescription(self),
      newDescription: description
    });

    self.s.serverDescription = description;
  }
}

function changedIsMaster(self: any, currentIsmaster?: {[key:string]: any}, ismaster?: {[key:string]: any}): boolean {
  const currentType: string = getTopologyType(self, currentIsmaster);
  const newType: string = getTopologyType(self, ismaster);
  
  return newType !== currentType
  // if (newType !== currentType){ return true;}
  // 
  // return false;
}

function getTopologyType(self: any, ismaster?: {[key:string]: any}): string {
  if (!ismaster) {
    ismaster = self.ismaster;
  }

  if (!ismaster) {return 'Unknown';}
  
  if (ismaster.ismaster && ismaster.msg === 'isdbgrid') {return 'Mongos';}
  
  if (ismaster.ismaster && !ismaster.hosts) {return 'Standalone';}
  
  if (ismaster.ismaster){ return 'RSPrimary';}
  
  if (ismaster.secondary){ return 'RSSecondary';}
  
  if (ismaster.arbiterOnly) {return 'RSArbiter';}
  
  return 'Unknown';
}

function inquireServerState (self: any): (callback: Callback) => void {
  return (callback?: Callback):void => {
    if (self.s.state === 'destroyed'){ return;}
    // Record response time
    // var start = new Date().getTime();
    const start: number = performance.now()

    // emitSDAMEvent
    emitSDAMEvent(self, 'serverHeartbeatStarted', { connectionId: self.name });

    // Attempt to execute ismaster command
    self.command('admin.$cmd', { ismaster: true }, { monitoring: true }, (err?: Error, r?: CommandResult): void => {
      // Calculate latencyMS
      // var latencyMS = new Date().getTime() - start;
      const latencyMS: number = calculateDurationInMS(start)
      
      if (!err) {
        // Legacy event sender
        self.emit('ismaster', r, self);

        // Server heart beat event
        emitSDAMEvent(self, 'serverHeartbeatSucceeded', {
          durationMS: latencyMS,
          reply: r.result,
          connectionId: self.name
        });

        // Did the server change
        if (changedIsMaster(self, self.s.ismaster, r.result)) {
          // Emit server description changed if something listening
          emitServerDescriptionChanged(self, {
            address: self.name,
            arbiters: [],
            hosts: [],
            passives: [],
            type: !self.s.inTopology ? 'Standalone' : getTopologyType(self)
          });
        }

        // Update ismaster view
        self.s.ismaster = r.result;

        // Set server response time
        self.s.isMasterLatencyMS = latencyMS;
      } else {
        emitSDAMEvent(self, 'serverHeartbeatFailed', {
          durationMS: latencyMS,
          failure: err,
          connectionId: self.name
        });
      }

      // Peforming an ismaster monitoring callback operation
      if (typeof callback === 'function') {
        return callback(err, r);
      }

      // Perform another sweep
      self.s.inquireServerStateTimeout = setTimeout(inquireServerState(self), self.s.haInterval);
    });
  }
}

//
// Clone the options
// var cloneOptions = function(options) {
//   var opts = {};
//   for (var name in options) {
//     opts[name] = options[name];
//   }
//   return opts;
// };

// function Interval(fn, time) {
//   var timer = false;
// 
//   this.start = function() {
//     if (!this.isRunning()) {
//       timer = setInterval(fn, time);
//     }
// 
//     return this;
//   };
// 
//   this.stop = function() {
//     clearInterval(timer);
//     timer = false;
//     return this;
//   };
// 
//   this.isRunning = function() {
//     return timer !== false;
//   };
// }

/** A custom interval representation. */
class Interval {
  timer: number = NaN;
  fn: Function
  time: number
  
  /** Creates an interval. */
  constructor(fn: Function, time: number) {
    this.fn = fn
    this.time = time
  }
  
  /** Starts an intetval. */
  start(): Interval {
    if (!this.isRunning()) {
      this.timer = setInterval(this.fn, this.time);
    }

    return this;
  }
  
  /** Stops an interval. */
  stop(): Interval {
    clearTimeout(this.timer);
    this.timer = NaN;
    return this;
  }
  
  /** Is this interval running? */
  isRunning(): boolean {
    return this.timer !== NaN
  }
}

/** A custom timeout representation. */
class Timeout {
  timer: number = NaN;
  fn: Function
  time: number
  
  /** Creates a timeout. */
  constructor(fn: Function, time: number) {
    this.fn = fn
    this.time = time
  }
  
  /** Starts a timeout. */
  start(): Interval {
    if (!this.isRunning()) {
      this.timer = setTimeout(this.fn, this.time);
    }

    return this;
  }
  
  /** Stops a timeout. */
  stop(): Interval {
    clearTimeout(this.timer);
    this.timer = NaN;
    return this;
  }
  
  /** Is this timeout running? */
  isRunning(): boolean {
    return this.timer !== NaN
  }
}

// function Timeout(fn, time) {
//   var timer = false;
// 
//   this.start = function() {
//     if (!this.isRunning()) {
//       timer = setTimeout(fn, time);
//     }
//     return this;
//   };
// 
//   this.stop = function() {
//     clearTimeout(timer);
//     timer = false;
//     return this;
//   };
// 
//   this.isRunning = function() {
//     if (timer && timer._called) return false;
//     return timer !== false;
//   };
// }

function diff(previous: {servers: ServerDescription[], [key:string]:any}= { servers: [] }, current: {servers: ServerDescription[], [key:string]:any}= { servers: [] }): {servers: ServerDescription[]} {
  // Difference document
  const diff:  {servers: ServerDescription[]} = {  servers: [] };

  // // Previous entry
  // if (!previous) {
  //   previous = { servers: [] };
  // }

  let i: number = 0;
  let j: number = 0
    let found: boolean = false;
    
  // Check if we have any previous servers missing in the current ones
  for (i= 0; i < previous.servers.length; i++) {
    for (j = 0; j < current.servers.length; j++) {
      if (current.servers[j].address.toLowerCase() === previous.servers[i].address.toLowerCase()) {
        found = true;
        break;
      }
    }

    if (!found) {
      // Add to the diff
      diff.servers.push({
        address: previous.servers[i].address,
        from: previous.servers[i].type,
        to: ServerType.Unknown
      });
    }
  }

  // Check if there are any severs that don't exist
  for (j = 0; j < current.servers.length; j++) {
    found = false;

    // Go over all the previous servers
    for (i = 0; i < previous.servers.length; i++) {
      if (previous.servers[i].address.toLowerCase() === current.servers[j].address.toLowerCase()) {
        found = true;
        break;
      }
    }

    // Add the server to the diff
    if (!found) {
      diff.servers.push({
        address: current.servers[j].address,
        from: ServerType.Unknown,
        to: current.servers[j].type
      });
    }
  }

  // Got through all the servers
  for (i = 0; i < previous.servers.length; i++) {
    let prevServer: ServerDescription = previous.servers[i];

    // Go through all current servers
    for (j = 0; j < current.servers.length; j++) {
      let currServer: ServerDescription = current.servers[j];

      // Matching server
      if (prevServer.address.toLowerCase() === currServer.address.toLowerCase()) {
        // We had a change in state
        if (prevServer.type !== currServer.type) {
          diff.servers.push({
            address: prevServer.address,
            from: prevServer.type,
            to: currServer.type
          });
        }
      }
    }
  }

  // Return difference
  return diff;
}

/**
 * Shared function to determine clusterTime for a given topology
 *
 * @param {*} topology
 * @param {*} clusterTime
 */
function resolveClusterTime(topology, $clusterTime) {
  if (topology.clusterTime == null) {
    topology.clusterTime = $clusterTime;
  } else {
    if ($clusterTime.clusterTime.greaterThan(topology.clusterTime.clusterTime)) {
      topology.clusterTime = $clusterTime;
    }
  }
}

// NOTE: this is a temporary move until the topologies can be more formally refactored
//       to share code.
const SessionMixins = {
  endSessions: function(sessions, callback) {
    if (!Array.isArray(sessions)) {
      sessions = [sessions];
    }

    // TODO:
    //   When connected to a sharded cluster the endSessions command
    //   can be sent to any mongos. When connected to a replica set the
    //   endSessions command MUST be sent to the primary if the primary
    //   is available, otherwise it MUST be sent to any available secondary.
    //   Is it enough to use: ReadPreference.primaryPreferred ?
    this.command(
      'admin.$cmd',
      { endSessions: sessions },
      { readPreference: ReadPreference.primaryPreferred },
      () => {
        // intentionally ignored, per spec
        if (typeof callback === 'function') callback();
      }
    );
  }
};

function topologyType(topology) {
  if (topology.description) {
    return topology.description.type;
  }

  if (topology.type === 'mongos') {
    return TopologyType.Sharded;
  } else if (topology.type === 'replset') {
    return TopologyType.ReplicaSetWithPrimary;
  }

  return TopologyType.Single;
}

const RETRYABLE_WIRE_VERSION = 6;

/**
 * Determines whether the provided topology supports retryable writes
 *
 * @param {Mongos|Replset} topology
 */
const isRetryableWritesSupported = function(topology) {
  const maxWireVersion = topology.lastIsMaster().maxWireVersion;
  if (maxWireVersion < RETRYABLE_WIRE_VERSION) {
    return false;
  }

  if (!topology.logicalSessionTimeoutMinutes) {
    return false;
  }

  if (topologyType(topology) === TopologyType.Single) {
    return false;
  }

  return true;
};

module.exports.SessionMixins = SessionMixins;
module.exports.resolveClusterTime = resolveClusterTime;
module.exports.inquireServerState = inquireServerState;
module.exports.getTopologyType = getTopologyType;
module.exports.emitServerDescriptionChanged = emitServerDescriptionChanged;
module.exports.emitTopologyDescriptionChanged = emitTopologyDescriptionChanged;
module.exports.cloneOptions = cloneOptions;
module.exports.createClientInfo = createClientInfo;
module.exports.createCompressionInfo = createCompressionInfo;
module.exports.clone = clone;
module.exports.diff = diff;
module.exports.Interval = Interval;
module.exports.Timeout = Timeout;
module.exports.isRetryableWritesSupported = isRetryableWritesSupported;
