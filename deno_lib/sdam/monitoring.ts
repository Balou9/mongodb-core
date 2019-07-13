// 'use strict';

// const ServerDescription = require('./server_description').ServerDescription;
import { CommandResult} from "./../connection/command_result.ts"
import {ServerDescription} from "./server_description.ts"
import {TopologyDescription} from "./topology_description.ts"
// const calculateDurationInMS = require('../utils').calculateDurationInMS;
import { Callback, calculateDurationInMS} from "./../utils.ts"

/**
 * Published when server description changes.
 * That does NOT include changes to the RTT.
 */
export class ServerDescriptionChangedEvent {
  readonly topologyId: number
  readonly address: string
  readonly previousDescription: ServerDescription
  readonly newDescription: ServerDescription

  constructor(topologyId: number, address: string, previousDescription: ServerDescription, newDescription:ServerDescription) {
    // Object.assign(this, { topologyId, address, previousDescription, newDescription });
    this.topologyId = topologyId
    this.address = address
    this. previousDescription = previousDescription
    this. newDescription = newDescription
  }
}

/** Published when server is initialized. */
export class ServerOpeningEvent {
  readonly topologyId: number
  readonly address: string

  constructor(topologyId: number, address: string) {
    // Object.assign(this, { topologyId, address });
    this.topologyId = topologyId
    this.address = address
  }
}

/** Published when server is closed. */
export class ServerClosedEvent {
  readonly topologyId: number
  readonly address: string

  constructor(topologyId: number, address: string) {
    // Object.assign(this, { topologyId, address });
    this.topologyId = topologyId
    this.address = address
  }
}

/** Published when topology description changes. */
export class TopologyDescriptionChangedEvent {
  readonly topologyId: number
  readonly previousDescription: TopologyDescription
  readonly newDescription: TopologyDescription

  constructor(topologyId: number, previousDescription: TopologyDescription, newDescription: TopologyDescription) {
    this.topologyId = topologyId
    this. previousDescription = previousDescription
    this. newDescription = newDescription
  }
}

/** Published when a topology is initialized. */
export class TopologyOpeningEvent {
  readonly topologyId: number

  constructor(topologyId: number ) {
    this.topologyId = topologyId
  }
}

/** Published when a topology is closed. */
export class TopologyClosedEvent {
  readonly topologyId: number

  constructor(topologyId: number ) {
    this.topologyId = topologyId
  }
}

/**
 * Fired when the server monitor’s ismaster command is started - immediately before
 * the ismaster command is serialized into raw BSON and written to the socket.
 */
export class ServerHeartbeatStartedEvent {
  readonly connectionId: number

  constructor(connectionId: number) {
    this.connectionId = connectionId
  }
}

/** Fired when the server monitor’s ismaster succeeds. */
export class ServerHeartbeatSucceededEvent {
  readonly duration: number
  readonly reply : {[key:string]: any}
  readonly connectionId: number

  constructor(duration: number, reply: {[key:string]: any}, connectionId: number) {
    // Object.assign(this, { duration, reply, connectionId });
    this.duration = duration
    this.reply = reply
    this.connectionId = connectionId
  }
}

/**
 * Fired when the server monitor’s ismaster fails, either with an “ok: 0” or a
 * socket exception.
 */
export class ServerHeartbeatFailedEvent {
  readonly duration: number
  readonly failure: {[key:string]: any} | Error
  readonly connectionId: number

  constructor(duration: number, failure: {[key:string]: any} | Error, connectionId: number) {
    // Object.assign(this, { duration, failure, connectionId });
    this.duration = duration
this.failure = failure
this. connectionId = connectionId
  }
}

/**
 * Performs a server check as described by the SDAM spec.
 *
 * NOTE: This method automatically reschedules itself, so that there is always an active
 * monitoring process.
 */
export function monitorServer(server: unknown, options: {[key:string]: any} = {}): void {
  // options = options || {};
  const heartbeatFrequencyMs: number = options.heartbeatFrequencyMS || 10000;

  if (options.initial) {
    server.s.monitorId = setTimeout((): void => monitorServer(server), heartbeatFrequencyMs);
    return;
  }

  // executes a single check of a server
  const checkServer: (callback: Callback) => void = (callback: Callback): void => {
    // let start = process.hrtime();
    const start: number = performance.now()

    // emit a signal indicating we have started the heartbeat
    server.emit('serverHeartbeatStarted', new ServerHeartbeatStartedEvent(server.name));

    // NOTE: legacy monitoring event
    // process.nextTick((): void => server.emit('monitoring', server));
    // sertTimeout((): void => server.emit('monitoring', server), 0);

    server.command(
      'admin.$cmd',
      { ismaster: true },
      {
        monitoring: true,
        socketTimeout: server.s.options.connectionTimeout || 2000
      },
      (err: Error, result: CommandResult): void => {
      const duration: number = calculateDurationInMS(start);

        if (err) {
          server.emit(
            'serverHeartbeatFailed',
            new ServerHeartbeatFailedEvent(duration, err, server.name)
          );

          return callback(err, null);
        }

        const ismaster = result.result;
        server.emit(
          'serverHeartbeatSucceded',
          new ServerHeartbeatSucceededEvent(duration, ismaster, server.name)
        );

        return callback(null, ismaster);
      }
    );
  };

  const successHandler: (ismaster: {[key:string]: any}) => void = (ismaster: {[key:string]: any}): void => {
    server.s.monitoring = false;

    // emit an event indicating that our description has changed
    server.emit('descriptionReceived', new ServerDescription(server.description.address, ismaster));

    // schedule the next monitoring process
    server.s.monitorId = setTimeout((): void => monitorServer(server), heartbeatFrequencyMs);
  };

  // run the actual monitoring loop
  server.s.monitoring = true;

  checkServer((err: Error, ismaster: {[key:string]: any}): void => {
    if (!err) {
      return successHandler(ismaster);
    }

    // According to the SDAM specification's "Network error during server check" section, if
    // an ismaster call fails we reset the server's pool. If a server was once connected,
    // change its type to `Unknown` only after retrying once.
    server.s.pool.reset((): void => {
      // otherwise re-attempt monitoring once
      checkServer((error: Error, ismaster: {[key:string]: any}): void => {
        if (error) {
          server.s.monitoring = false;

          // we revert to an `Unknown` by emitting a default description with no ismaster
          server.emit(
            'descriptionReceived',
            new ServerDescription(server.description.address, null, { error })
          );

          // we do not reschedule monitoring in this case
          return;
        }

        successHandler(ismaster);
      });
    });
  });
}

// module.exports = {
//   ServerDescriptionChangedEvent,
//   ServerOpeningEvent,
//   ServerClosedEvent,
//   TopologyDescriptionChangedEvent,
//   TopologyOpeningEvent,
//   TopologyClosedEvent,
//   ServerHeartbeatStartedEvent,
//   ServerHeartbeatSucceededEvent,
//   ServerHeartbeatFailedEvent,
//   monitorServer
// };
