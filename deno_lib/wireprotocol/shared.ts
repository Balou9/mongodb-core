// const ReadPreference = require('../topologies/read_preference');
import { ReadPreference } from "./../topologies/read_preference.ts";
// const MongoError = require('../error').MongoError;
import { MongoError} from "./../errors.ts";
// const ServerType = require('../sdam/server_description').ServerType;
import {ServerType} from "./../sdam/server_description.ts";
// const TopologyDescription = require('../sdam/topology_description').TopologyDescription;
import { TopologyDescription } from "./../sdam/topology_description.ts";

import { readInt32LE } from "./../utils.ts";

export const MESSAGE_HEADER_SIZE: number = 16;
export const COMPRESSION_DETAILS_SIZE: number = 9; // originalOpcode + uncompressedSize, compressorID

// OPCODE Numbers
// Defined at https://docs.mongodb.com/manual/reference/mongodb-wire-protocol/#request-opcodes
export const OPCODES: {[key:string]: number} = {
  OP_REPLY: 1,
  OP_UPDATE: 2001,
  OP_INSERT: 2002,
  OP_QUERY: 2004,
  OP_GETMORE: 2005,
  OP_DELETE: 2006,
  OP_KILL_CURSORS: 2007,
  OP_COMPRESSED: 2012,
  OP_MSG: 2013
};

export function getReadPreference(cmd: unknown, options: {[key:string]: any}): ReadPreference {
  // Default to command version of the readPreference
  let readPreference: ReadPreference = cmd.readPreference || new ReadPreference('primary');
  // If we have an option readPreference override the command one
  if (options.readPreference) {
    readPreference = options.readPreference;
  }

  if (typeof readPreference === 'string') {
    readPreference = new ReadPreference(readPreference);
  }

  if (!(readPreference instanceof ReadPreference)) {
    throw new MongoError('read preference must be a ReadPreference instance');
  }

  return readPreference;
};

export interface MsgHeader {
  length: number;
  requestId: number;
  responseTo: number;
  opCode: number;
}

// Parses the header of a wire protocol message
export function parseMsgHeader(message: Uint8Array): MsgHeader  {
  return {
    length: readInt32LE(message, 0),
    requestId: readInt32LE(message, 4),
    responseTo: readInt32LE(message, 8),
    opCode: readInt32LE(message, 12)
  };
};

export function applyCommonQueryOptions(queryOptions:{[key:string]: any}, options:{[key:string]: any}): {[key:string]: any} {
  Object.assign(queryOptions, {
    raw: typeof options.raw === 'boolean' ? options.raw : false,
    // promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
    promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
    // promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false,
    monitoring: typeof options.monitoring === 'boolean' ? options.monitoring : false,
    fullResult: typeof options.fullResult === 'boolean' ? options.fullResult : false
  });

  if (typeof options.socketTimeout === 'number') {
    queryOptions.socketTimeout = options.socketTimeout;
  }

  if (options.session) {
    queryOptions.session = options.session;
  }

  if (typeof options.documentsReturnedIn === 'string') {
    queryOptions.documentsReturnedIn = options.documentsReturnedIn;
  }

  return queryOptions;
}

export function isSharded(topologyOrServer: unknown): boolean {
  if (topologyOrServer.type === 'mongos') return true;
  if (topologyOrServer.description && topologyOrServer.description.type === ServerType.Mongos) {
    return true;
  }

  // NOTE: This is incredibly inefficient, and should be removed once command construction
  //       happens based on `Server` not `Topology`.
  if (topologyOrServer.description && topologyOrServer.description instanceof TopologyDescription) {
    const servers: unknown[] = Array.from(topologyOrServer.description.servers.values());
    return servers.some((server: unknown): boolean => server.type === ServerType.Mongos);
  }

  return false;
}

export function databaseNamespace(ns: string): string {
  return ns ? ns.split('.')[0] : "";
}

export function collectionNamespace(ns: string): string {
  return ns ? ns.split('.').slice(1).join('.') : "";
}

// module.exports = {
//   getReadPreference,
//   MESSAGE_HEADER_SIZE,
//   COMPRESSION_DETAILS_SIZE,
//   opcodes,
//   parseMsgHeader,
//   applyCommonQueryOptions,
//   isSharded,
//   databaseNamespace,
//   collectionNamespace
// };
