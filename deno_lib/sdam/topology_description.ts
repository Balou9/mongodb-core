// 'use strict';

import {ObjectId} from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const ServerType = require('./server_description').ServerType;
import { ServerType, ServerDescription } from "./server_description.ts"
// const ServerDescription = require('./server_description').ServerDescription;
// import { ReadPreference} from "./../topologies/read_preference.ts"
// const ReadPreference = require('../topologies/read_preference');
import { MongoError} from "./../errors.ts"
// const WIRE_CONSTANTS = require('../wireprotocol/constants');
import {MIN_SUPPORTED_SERVER_VERSION,
  MAX_SUPPORTED_SERVER_VERSION,
MIN_SUPPORTED_WIRE_VERSION,
MAX_SUPPORTED_WIRE_VERSION
 } from "./../wireprotocol/constants.ts"

// contstants related to compatability checks
// const MIN_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_SERVER_VERSION;
// const MAX_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_SERVER_VERSION;
// const MIN_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_WIRE_VERSION;
// const MAX_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_WIRE_VERSION;

// An enumeration of topology types we know about
export const TopologyType: {[key:string]: string} = {
  Single: 'Single',
  ReplicaSetNoPrimary: 'ReplicaSetNoPrimary',
  ReplicaSetWithPrimary: 'ReplicaSetWithPrimary',
  Sharded: 'Sharded',
  Unknown: 'Unknown'
};

/** Representation of a deployment of servers. */
export class TopologyDescription {
  readonly type: string
  readonly setName: string

  readonly maxSetVersion: number
  readonly maxElectionId: ObjectId
  readonly servers: Map<string, ServerDescription>
  readonly stale: boolean
  readonly compatible: boolean
readonly   compatibilityError: string
  readonly logicalSessionTimeoutMinutes: number
readonly   heartbeatFrequencyMs: number
readonly   localThresholdMs: number
readonly   options: {[key:string]:any}
readonly   error: Error
  // compatibilityError: Error
readonly   commonWireVersion: number


  /**
   * Create a TopologyDescription
   *
   * @param {string} topologyType
   * @param {Map<string, ServerDescription>} serverDescriptions the a map of address to ServerDescription
   * @param {string} setName
   * @param {number} maxSetVersion
   * @param {ObjectId} maxElectionId
   */

  constructor(
    topologyType: string,
    serverDescriptions: Map<string, ServerDescription>,
    setName: string,
    maxSetVersion: number,
    maxElectionId: ObjectId,
    commonWireVersion?: number,
    options: {[key:string]:any} = {},
    error?: Error
  ) {
    // options = options || {};

    // TODO: consider assigning all these values to a temporary value `s` which
    //       we use `Object.freeze` on, ensuring the internal state of this type
    //       is immutable.
    this.type = topologyType || TopologyType.Unknown;
    this.setName = setName || null;
    this.maxSetVersion = maxSetVersion || null;
    this.maxElectionId = maxElectionId || null;
    this.servers = serverDescriptions || new Map<string, ServerDescription>();
    this.stale = false;
    this.compatible = true;
    this.compatibilityError = null;
    this.logicalSessionTimeoutMinutes = null;
    this.heartbeatFrequencyMs = options.heartbeatFrequencyMs || 0;
    this.localThresholdMs = options.localThresholdMs || 0;
    this.options = options;
    this.error = error;
    this.commonWireVersion = commonWireVersion || null;

    // determine server compatibility
    for (const serverDescription of this.servers.values()) {
      if (serverDescription.type === ServerType.Unknown) {continue;}

      if (serverDescription.minWireVersion > MAX_SUPPORTED_WIRE_VERSION) {
        this.compatible = false;
        this.compatibilityError = `Server at ${serverDescription.address} requires wire version ${
          serverDescription.minWireVersion
        }, but this version of the driver only supports up to ${MAX_SUPPORTED_WIRE_VERSION} (MongoDB ${MAX_SUPPORTED_SERVER_VERSION})`;
      }

      if (serverDescription.maxWireVersion < MIN_SUPPORTED_WIRE_VERSION) {
        this.compatible = false;
        this.compatibilityError = `Server at ${serverDescription.address} reports wire version ${
          serverDescription.maxWireVersion
        }, but this version of the driver requires at least ${MIN_SUPPORTED_WIRE_VERSION} (MongoDB ${MIN_SUPPORTED_SERVER_VERSION}).`;
        break;
      }
    }

    // Whenever a client updates the TopologyDescription from an ismaster response, it MUST set
    // TopologyDescription.logicalSessionTimeoutMinutes to the smallest logicalSessionTimeoutMinutes
    // value among ServerDescriptions of all data-bearing server types. If any have a null
    // logicalSessionTimeoutMinutes, then TopologyDescription.logicalSessionTimeoutMinutes MUST be
    // set to null.
    const readableServers: ServerDescription[] = Array.from(this.servers.values()).filter((s: ServerDescription): boolean => s.isReadable);

    this.logicalSessionTimeoutMinutes = readableServers.reduce((result: number, server: ServerDescription): number => {
      if (!server.logicalSessionTimeoutMinutes) {return null;}

      if (!result){ return server.logicalSessionTimeoutMinutes;}

      return Math.min(result, server.logicalSessionTimeoutMinutes);
    }, null);
  }

  /**
   * Returns a copy of this description updated with a given ServerDescription
   */
  update(serverDescription: ServerDescription): TopologyDescription {
    const address: string = serverDescription.address;
    // NOTE: there are a number of prime targets for refactoring here
    //       once we support destructuring assignments

    // potentially mutated values
    let topologyType: string = this.type;
    let setName: string = this.setName;
    let maxSetVersion: number = this.maxSetVersion;
    let maxElectionId: ObjectId = this.maxElectionId;
    let commonWireVersion: number = this.commonWireVersion;
    let error: Error = serverDescription.error || null;

    const serverType: string = serverDescription.type;

    const serverDescriptions: Map<string, ServerDescription> = new Map<string, ServerDescription>(this.servers);

    // update common wire version
    if (serverDescription.maxWireVersion !== 0) {
      if (!commonWireVersion) {
        commonWireVersion = serverDescription.maxWireVersion;
      } else {
        commonWireVersion = Math.min(commonWireVersion, serverDescription.maxWireVersion);
      }
    }

    // update the actual server description
    serverDescriptions.set(address, serverDescription);

    if (topologyType === TopologyType.Single) {
      // once we are defined as single, that never changes
      return new TopologyDescription(
        TopologyType.Single,
        serverDescriptions,
        setName,
        maxSetVersion,
        maxElectionId,
        commonWireVersion,
        this.options,
        error
      );
    }

    if (topologyType === TopologyType.Unknown) {
      if (serverType === ServerType.Standalone) {
        serverDescriptions.delete(address);
      } else {
        topologyType = topologyTypeForServerType(serverType);
      }
    }

    if (topologyType === TopologyType.Sharded) {
      if ([ServerType.Mongos, ServerType.Unknown].indexOf(serverType) === -1) {
        serverDescriptions.delete(address);
      }
    }

    if (topologyType === TopologyType.ReplicaSetNoPrimary) {
      if ([ServerType.Mongos, ServerType.Unknown].indexOf(serverType) >= 0) {
        serverDescriptions.delete(address);
      }

      if (serverType === ServerType.RSPrimary) {
        const result: unknown = updateRsFromPrimary(
          serverDescriptions,
          setName,
          serverDescription,
          maxSetVersion,
          maxElectionId
        );

        (topologyType = result[0]),
          (setName = result[1]),
          (maxSetVersion = result[2]),
          (maxElectionId = result[3]);
      } else if (
        [ServerType.RSSecondary, ServerType.RSArbiter, ServerType.RSOther].indexOf(serverType) >= 0
      ) {
        const result: unknown = updateRsNoPrimaryFromMember(serverDescriptions, setName, serverDescription);
        (topologyType = result[0]), (setName = result[1]);
      }
    }

    if (topologyType === TopologyType.ReplicaSetWithPrimary) {
      if ([ServerType.Standalone, ServerType.Mongos].indexOf(serverType) >= 0) {
        serverDescriptions.delete(address);
        topologyType = checkHasPrimary(serverDescriptions);
      } else if (serverType === ServerType.RSPrimary) {
        const result: unknown = updateRsFromPrimary(
          serverDescriptions,
          setName,
          serverDescription,
          maxSetVersion,
          maxElectionId
        );

        (topologyType = result[0]),
          (setName = result[1]),
          (maxSetVersion = result[2]),
          (maxElectionId = result[3]);
      } else if (
        [ServerType.RSSecondary, ServerType.RSArbiter, ServerType.RSOther].indexOf(serverType) >= 0
      ) {
        topologyType = updateRsWithPrimaryFromMember(
          serverDescriptions,
          setName,
          serverDescription
        );
      } else {
        topologyType = checkHasPrimary(serverDescriptions);
      }
    }

    return new TopologyDescription(
      topologyType,
      serverDescriptions,
      setName,
      maxSetVersion,
      maxElectionId,
      commonWireVersion,
      this.options,
      error
    );
  }

  // /**
  //  * Determines if the topology has a readable server available. See the table in the
  //  * following section for behaviour rules.
  //  *
  //  * @param {ReadPreference} [readPreference] An optional read preference for determining if a readable server is present
  //  * @return {Boolean} Whether there is a readable server in this topology
  //  */
  // hasReadableServer(/* readPreference */) {
  //   // To be implemented when server selection is implemented
  // }
  //
  // /**
  //  * Determines if the topology has a writable server available. See the table in the
  //  * following section for behaviour rules.
  //  *
  //  * @return {Boolean} Whether there is a writable server in this topology
  //  */
  // hasWritableServer() {
  //   return this.hasReadableServer(ReadPreference.primary);
  // }

  /** Determines if the topology has a definition for the provided address. */
  hasServer(address: string): boolean {
    return this.servers.has(address);
  }
}

function topologyTypeForServerType(serverType: string): string {
  if (serverType === ServerType.Mongos){ return TopologyType.Sharded;}

  if (serverType === ServerType.RSPrimary) {return TopologyType.ReplicaSetWithPrimary;}

  return TopologyType.ReplicaSetNoPrimary;
}

function updateRsFromPrimary(
  serverDescriptions:  Map<string, ServerDescription>,
  setName: string,
  serverDescription: ServerDescription,
  maxSetVersion: number,
  maxElectionId: ObjectId
): [string, string, number, ObjectId] {
  setName = setName || serverDescription.setName;

  if (setName !== serverDescription.setName) {
    serverDescriptions.delete(serverDescription.address);

    return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
  }

  const electionIdOID: ObjectId = serverDescription.electionId ? serverDescription.electionId.$oid : null;
  const maxElectionIdOID: ObjectId = maxElectionId ? maxElectionId.$oid : null;

  if (serverDescription.setVersion != null && electionIdOID != null) {
    if (maxSetVersion != null && maxElectionIdOID != null) {
      if (maxSetVersion > serverDescription.setVersion || maxElectionIdOID > electionIdOID) {
        // this primary is stale, we must remove it
        serverDescriptions.set(
          serverDescription.address,
          new ServerDescription(serverDescription.address)
        );

        return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
      }
    }

    maxElectionId = serverDescription.electionId;
  }

  if (
    serverDescription.setVersion != null &&
    (maxSetVersion == null || serverDescription.setVersion > maxSetVersion)
  ) {
    maxSetVersion = serverDescription.setVersion;
  }

  // We've heard from the primary. Is it the same primary as before?
  for (const address of serverDescriptions.keys()) {
    const server = serverDescriptions.get(address);

    if (server.type === ServerType.RSPrimary && server.address !== serverDescription.address) {
      // Reset old primary's type to Unknown.
      serverDescriptions.set(address, new ServerDescription(server.address));

      // There can only be one primary
      break;
    }
  }

  // Discover new hosts from this primary's response.
  serverDescription.allHosts.forEach((address: string): void => {
    if (!serverDescriptions.has(address)) {
      serverDescriptions.set(address, new ServerDescription(address));
    }
  });

  // Remove hosts not in the response.
  const currentAddresses: string[] = Array.from(serverDescriptions.keys());
  const responseAddresses: string[] = serverDescription.allHosts;

  currentAddresses.filter((address: string ): boolean => responseAddresses.indexOf(address) === -1).forEach((address: string): void => {
    serverDescriptions.delete(address);
  });

  return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
}

function updateRsWithPrimaryFromMember(serverDescriptions: Map<string, ServerDescription>, setName: string, serverDescription: ServerDescription): string {
  if (!setName) {
    throw new MongoError('updateRsWithPrimaryFromMember requires a setName');
  }

  if (
    setName !== serverDescription.setName ||
    (serverDescription.me && serverDescription.address !== serverDescription.me)
  ) {
    serverDescriptions.delete(serverDescription.address);
  }

  return checkHasPrimary(serverDescriptions);
}

function updateRsNoPrimaryFromMember(serverDescriptions: Map<string, ServerDescription>, setName: string, serverDescription: ServerDescription): [string, string] {
  setName = setName || serverDescription.setName;

  const topologyType: string = TopologyType.ReplicaSetNoPrimary;

  if (setName !== serverDescription.setName) {
    serverDescriptions.delete(serverDescription.address);
    return [topologyType, setName];
  }

  serverDescription.allHosts.forEach((address: string): void => {
    if (!serverDescriptions.has(address)) {
      serverDescriptions.set(address, new ServerDescription(address));
    }
  });

  if (serverDescription.me && serverDescription.address !== serverDescription.me) {
    serverDescriptions.delete(serverDescription.address);
  }

  return [topologyType, setName];
}

function checkHasPrimary(serverDescriptions: Map<string, ServerDescription>): string {
  for (const addr of serverDescriptions.keys()) {
    if (serverDescriptions.get(addr).type === ServerType.RSPrimary) {
      return TopologyType.ReplicaSetWithPrimary;
    }
  }

  return TopologyType.ReplicaSetNoPrimary;
}

// module.exports = {
//   TopologyType,
//   TopologyDescription
// };
