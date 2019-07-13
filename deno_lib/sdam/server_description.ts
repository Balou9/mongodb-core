// 'use strict';

// An enumeration of server types we know about
export const ServerType: {[key:string]: any} = {
  Standalone: 'Standalone',
  Mongos: 'Mongos',
  PossiblePrimary: 'PossiblePrimary',
  RSPrimary: 'RSPrimary',
  RSSecondary: 'RSSecondary',
  RSArbiter: 'RSArbiter',
  RSOther: 'RSOther',
  RSGhost: 'RSGhost',
  Unknown: 'Unknown'
};

const WRITABLE_SERVER_TYPES: Set<string> = new Set([
  ServerType.RSPrimary,
  ServerType.Standalone,
  ServerType.Mongos
]);

const ISMASTER_FIELDS: string[]= [
  'minWireVersion',
  'maxWireVersion',
  'maxBsonObjectSize',
  'maxMessageSizeBytes',
  'maxWriteBatchSize',
  'compression',
  'me',
  'hosts',
  'passives',
  'arbiters',
  'tags',
  'setName',
  'setVersion',
  'electionId',
  'primary',
  'logicalSessionTimeoutMinutes',
  'saslSupportedMechs',
  '__nodejs_mock_server__',
  '$clusterTime'
];

/** Parses an `ismaster` message and determines the server type. */
function parseServerType(ismaster: {[key:string]: any}): string {
  if (!ismaster || !ismaster.ok) {
    return ServerType.Unknown;
  }

  if (ismaster.isreplicaset) {
    return ServerType.RSGhost;
  }

  if (ismaster.msg && ismaster.msg === 'isdbgrid') {
    return ServerType.Mongos;
  }

  if (ismaster.setName) {
    if (ismaster.hidden) {
      return ServerType.RSOther;
    } else if (ismaster.ismaster) {
      return ServerType.RSPrimary;
    } else if (ismaster.secondary) {
      return ServerType.RSSecondary;
    } else if (ismaster.arbiterOnly) {
      return ServerType.RSArbiter;
    } else {
      return ServerType.RSOther;
    }
  }

  return ServerType.Standalone;
}

/**
 * The client's view of a single server, based on the most recent ismaster outcome.
 * Internal type, not meant to be directly instantiated
 */
export class ServerDescription {
  readonly address: string

  error: Error
  roundTripTime: number
  lastUpdateTime: number
  lastWriteDate: number | Date
  opTime: number
  type: string
  me: string
  hosts: string[]
  passives: string[]
  arbiters: string[]

  minWireVersion: number
maxWireVersion: number
maxBsonObjectSize: number
maxMessageSizeBytes: number
maxWriteBatchSize: number
compression: {compressors: string[]}
// me: string
// hosts: string[]
// passives: string[]
// arbiters: string[]
tags: string[]
setName: string
setVersion: unknown
electionId: unknown
primary: unknown
logicalSessionTimeoutMinutes: number
saslSupportedMechs: unknown
__nodejs_mock_server__: unknown
$clusterTime: unknown

  /** Creates a server description. */
  constructor(address: string, ismaster: {[key:string]: any}, options: {[key:string]: any} = {}) {
    // options = options || {};
    ismaster =       {
            minWireVersion: 0,
            maxWireVersion: 0,
            hosts: [],
            passives: [],
            arbiters: [],
            tags: [],
            ...ismaster
          }

    this.address = address;
    this.error = options.error || null;
    this.roundTripTime = options.roundTripTime || 0;
    this.lastUpdateTime = Date.now();
    this.lastWriteDate = ismaster.lastWrite ? ismaster.lastWrite.lastWriteDate : null;
    this.opTime = ismaster.lastWrite ? ismaster.lastWrite.opTime : null;
    this.type = parseServerType(ismaster);

    // direct mappings
    ISMASTER_FIELDS.forEach((field: string ): void => {
      if (typeof ismaster[field] !== 'undefined') {this[field] = ismaster[field];}
    });

    // normalize case for hosts
    if (this.me) {this.me = this.me.toLowerCase();}

    this.hosts = this.hosts.map((host: string): string => host.toLowerCase());
    this.passives = this.passives.map((host: string): string => host.toLowerCase());
    this.arbiters = this.arbiters.map((host: string): string => host.toLowerCase());
  }

  /** Get all hosts, including passive ones and arbiters. */
  get allHosts(): string[] {
    return this.hosts.concat(this.arbiters).concat(this.passives);
  }

  /** Is this server available for reads? */
  get isReadable(): boolean {
    return this.type === ServerType.RSSecondary || this.isWritable;
  }

  /** Is this server available for writes? */
  get isWritable() {
    return WRITABLE_SERVER_TYPES.has(this.type);
  }
}



// module.exports = {
//   ServerDescription,
//   ServerType
// };
