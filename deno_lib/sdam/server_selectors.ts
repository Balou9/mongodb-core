// 'use strict';
// const ServerType = require('./server_description').ServerType;
import { ServerType, ServerDescription} from "./server_description.ts"
// const TopologyType = require('./topology_description').TopologyType;
import { TopologyType, TopologyDescription} from "./topology_description.ts"
// const ReadPreference = require('../topologies/read_preference');
import {ReadPreference} from "./../topologies/read_preference.ts"
// const MongoError = require('../error').MongoError;
import { MongoError} from "./../errors.ts"

// max staleness constants
const IDLE_WRITE_PERIOD: number = 10000;
const SMALLEST_MAX_STALENESS_SECONDS: number = 90;

/** Returns a server selector that selects for writable servers. */
export function writableServerSelector(): (topologyDescription: TopologyDescription, servers: ServerDescription[]) => ServerDescription[]  {
  return function(topologyDescription: TopologyDescription, servers: ServerDescription[]): ServerDescription[] {
    return latencyWindowReducer(topologyDescription, servers.filter((s: ServerDescription): boolean => s.isWritable));
  };
}

/**
 * Reduces the passed in array of servers by the rules of the "Max Staleness" specification
 * found here: https://github.com/mongodb/specifications/blob/master/source/max-staleness/max-staleness.rst
 */
function maxStalenessReducer(readPreference: ReadPreference, topologyDescription: TopologyDescription, servers: ServerDescription[]): ServerDescription[] {
  if (readPreference.maxStalenessSeconds == null || readPreference.maxStalenessSeconds < 0) {
    return servers;
  }

  const maxStaleness: number = readPreference.maxStalenessSeconds;
  const maxStalenessVariance: number =
    (topologyDescription.heartbeatFrequencyMS + IDLE_WRITE_PERIOD) / 1000;

  if (maxStaleness < maxStalenessVariance) {
    throw new MongoError(`maxStalenessSeconds must be at least ${maxStalenessVariance} seconds`);
  }

  if (maxStaleness < SMALLEST_MAX_STALENESS_SECONDS) {
    throw new MongoError(
      `maxStalenessSeconds must be at least ${SMALLEST_MAX_STALENESS_SECONDS} seconds`
    );
  }

  if (topologyDescription.type === TopologyType.ReplicaSetWithPrimary) {
    const primary: ServerDescription = servers.filter(primaryFilter)[0];

    return servers.reduce((result: ServerDescription[], server: ServerDescription): ServerDescription[] => {
      const stalenessMs: number =
        server.lastUpdateTime -
        server.lastWriteDate -
        (primary.lastUpdateTime - primary.lastWriteDate) +
        topologyDescription.heartbeatFrequencyMS;

      const staleness: number = stalenessMs / 1000;

      if (staleness <= readPreference.maxStalenessSeconds) {result.push(server);}

      return result;
    }, []);
  } else if (topologyDescription.type === TopologyType.ReplicaSetNoPrimary) {
    const sMax: ServerDescription = servers.reduce((max:  ServerDescription, s:  ServerDescription):  ServerDescription => (s.lastWriteDate > max.lastWriteDate ? s : max));

    return servers.reduce((result:  ServerDescription[], server:  ServerDescription):  ServerDescription[] => {
      const stalenessMs: number =
        sMax.lastWriteDate - server.lastWriteDate + topologyDescription.heartbeatFrequencyMS;

      const staleness: number = stalenessMs / 1000;

      if (staleness <= readPreference.maxStalenessSeconds){ result.push(server);}

      return result;
    }, []);
  }

  return servers;
}

/** Determines whether a server's tags match a given set of tags. */
function tagSetMatch(tagSet: {[key:string]: any}, serverTags: {[key:string]: any}): boolean {
  const keys: string[] = Object.keys(tagSet);
  const serverTagKeys: string[] = Object.keys(serverTags);

  for (let i: number = 0; i < keys.length; ++i) {
    const key: string = keys[i];

    if (serverTagKeys.indexOf(key) === -1 || serverTags[key] !== tagSet[key]) {
      return false;
    }
  }

  return true;
}

/** Reduces a set of server descriptions based on tags requested by the read preference. */
function tagSetReducer(readPreference: ReadPreference, servers: ServerDescription[]): ServerDescription[] {
  if (
    readPreference.tags == null ||
    (Array.isArray(readPreference.tags) && readPreference.tags.length === 0)
  ) {
    return servers;
  }

  for (let i: number = 0; i < readPreference.tags.length; ++i) {
    const tagSet: {[key:string]: any}= readPreference.tags[i];

    const serversMatchingTagset: ServerDescription[] = servers.reduce((matched: ServerDescription[], server: ServerDescription):ServerDescription[] => {
      if (tagSetMatch(tagSet, server.tags)) {matched.push(server);}

      return matched;
    }, []);

    if (serversMatchingTagset.length) {
      return serversMatchingTagset;
    }
  }

  return [];
}

/**
 * Reduces a list of servers to ensure they fall within an acceptable latency window. This is
 * further specified in the "Server Selection" specification, found here:
 * https://github.com/mongodb/specifications/blob/master/source/server-selection/server-selection.rst
 *
 * @param {topologyDescription} topologyDescription The topology description
 * @param {ServerDescription[]} servers The list of servers to reduce
 * @returns {ServerDescription[]} The servers which fall within an acceptable latency window
 */
function latencyWindowReducer(topologyDescription: TopologyDescription, servers: ServerDescription[]): ServerDescription[] {
  const low: number = servers.reduce(
    (min, server) => (min === -1 ? server.roundTripTime : Math.min(server.roundTripTime, min)),
    -1
  );

  const high: number = low + topologyDescription.localThresholdMS;

  return servers.reduce((result: ServerDescription[], server: ServerDescription): ServerDescription[] => {
    if (server.roundTripTime <= high && server.roundTripTime >= low) {result.push(server);}

    return result;
  }, []);
}

// filters
function primaryFilter(server: ServerDescription) : boolean{
  return server.type === ServerType.RSPrimary;
}

function secondaryFilter(server: ServerDescription): boolean {
  return server.type === ServerType.RSSecondary;
}

function nearestFilter(server: ServerDescription): boolean {
  return server.type === ServerType.RSSecondary || server.type === ServerType.RSPrimary;
}

function knownFilter(server: ServerDescription): boolean {
  return server.type !== ServerType.Unknown;
}

/**
 * Returns a function which selects servers based on a provided read preference.
 */
export function readPreferenceServerSelector(readPreference: ReadPreference): (topologyDescription: TopologyDescription, servers: ServerDescription[]) => ServerDescription {
  if (!readPreference.isValid()) {
    throw new TypeError('Invalid read preference specified');
  }

  return (topologyDescription: TopologyDescription, servers: ServerDescription[]): ServerDescription => {
    const commonWireVersion: number = topologyDescription.commonWireVersion;

    if (
      commonWireVersion &&
      (readPreference.minWireVersion && readPreference.minWireVersion > commonWireVersion)
    ) {
      throw new MongoError(
        `Minimum wire version '${
          readPreference.minWireVersion
        }' required, but found '${commonWireVersion}'`
      );
    }

    if (
      topologyDescription.type === TopologyType.Single ||
      topologyDescription.type === TopologyType.Sharded
    ) {
      return latencyWindowReducer(topologyDescription, servers.filter(knownFilter));
    }

    if (readPreference.mode === ReadPreference.PRIMARY) {
      return servers.filter(primaryFilter);
    }

    if (readPreference.mode === ReadPreference.SECONDARY) {
      return latencyWindowReducer(
        topologyDescription,
        tagSetReducer(
          readPreference,
          maxStalenessReducer(readPreference, topologyDescription, servers)
        )
      ).filter(secondaryFilter);
    } else if (readPreference.mode === ReadPreference.NEAREST) {
      return latencyWindowReducer(
        topologyDescription,
        tagSetReducer(
          readPreference,
          maxStalenessReducer(readPreference, topologyDescription, servers)
        )
      ).filter(nearestFilter);
    } else if (readPreference.mode === ReadPreference.SECONDARY_PREFERRED) {
      const result: ServerDescription = latencyWindowReducer(
        topologyDescription,
        tagSetReducer(
          readPreference,
          maxStalenessReducer(readPreference, topologyDescription, servers)
        )
      ).filter(secondaryFilter);

      return result.length === 0 ? servers.filter(primaryFilter) : result;
    } else if (readPreference.mode === ReadPreference.PRIMARY_PREFERRED) {
      const result: ServerDescription  = servers.filter(primaryFilter);

      if (result.length) {
        return result;
      }

      return latencyWindowReducer(
        topologyDescription,
        tagSetReducer(
          readPreference,
          maxStalenessReducer(readPreference, topologyDescription, servers)
        )
      ).filter(secondaryFilter);
    }
  };
}

// module.exports = {
//   writableServerSelector,
//   readPreferenceServerSelector
// };
