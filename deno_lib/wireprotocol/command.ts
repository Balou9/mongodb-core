// 'use strict';

import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const Query = require('../connection/commands').Query;
import  { Query } from "./../connection/commands.ts"
// const Msg = require('../connection/msg').Msg;
import { Msg, BinMsg} from "./../connection/msg.ts"
import { MongoError } from "./../errors.ts"
// const MongoError = require('../error').MongoError;
// const getReadPreference = require('./shared').getReadPreference;
import { getReadPreference, isSharded, databaseNamespace } from "./shared.ts"
// const isSharded = require('./shared').isSharded;
// const databaseNamespace = require('./shared').databaseNamespace;
// const isTransactionCommand = require('../transactions').isTransactionCommand;
// import { isTransactionCommand } from "./../transactions.ts"
// const applySession = require('../sessions').applySession;
import { applySession} from "./../sessions.ts"

async function command(server: unknown, ns: string, cmd: {[key:string]: any}, options:{[key:string]: any} = {}/*, callback*/): Promise<void> {
  // if (typeof options === 'function') (callback = options), (options = {});
  // options = options || {};

  if (!cmd) {
    // return callback(new MongoError(`command ${JSON.stringify(cmd)} does not return a cursor`));
    throw new MongoError(`command ${JSON.stringify(cmd)} does not return a cursor`);
  }

  // const bson = server.s.bson;
  const pool: Pool = server.s.pool;
  const readPreference: ReadPreference = getReadPreference(cmd, options);
  const shouldUseOpMsg: boolean = supportsOpMsg(server);
  const session: Session = options.session;

  let clusterTime: BSON.Long = server.clusterTime;
  let finalCmd: {[key:string]: any} = { ...cmd }
  
  if (hasSessionSupport(server) && session) {
    if (
      session.clusterTime &&
      session.clusterTime.clusterTime.greaterThan(clusterTime.clusterTime)
    ) {
      clusterTime = session.clusterTime;
    }

    const err: Error = applySession(session, finalCmd, options);
    
    if (err) {
      // return callback(err);
      throw err;
    }
  }

  // if we have a known cluster time, gossip it
  if (clusterTime) {
    finalCmd.$clusterTime = clusterTime;
  }

  if (
    isSharded(server) &&
    !shouldUseOpMsg &&
    readPreference &&
    readPreference.preference !== 'primary'
  ) {
    finalCmd = {
      $query: finalCmd,
      $readPreference: readPreference.toJSON()
    };
  }

  const commandOptions: { [key:string]: any} =     {
        command: true,
        numberToSkip: 0,
        numberToReturn: -1,
        checkKeys: false,
        ...options
          // This value is not overridable
        , slaveOk:  readPreference.slaveOk()
      }

  // This value is not overridable
  // commandOptions.slaveOk = readPreference.slaveOk();

  const cmdNs: string = `${databaseNamespace(ns)}.$cmd`;
  const message: Msg | BinMsg = shouldUseOpMsg
    ? new Msg(/*bson,*/ cmdNs, finalCmd, commandOptions)
    : new Query(/*bson,*/ cmdNs, finalCmd, commandOptions);

  // const inTransaction: boolean = session && (session.inTransaction() || isTransactionCommand(finalCmd));
  
  // const commandResponseHandler = inTransaction
  //   ? function(err?: Error) {
  //       if (
  //         !cmd.commitTransaction &&
  //         err &&
  //         err instanceof MongoError &&
  //         err.hasErrorLabel('TransientTransactionError')
  //       ) {
  //         session.transaction.unpinServer();
  //       }
  // 
  //       return callback.apply(null, arguments);
  //     }
  //   : callback;

  return pool.write(message, commandOptions).finally((err?: Error | MongoError): void => {
      if (
        !cmd.commitTransaction &&
        err &&
        err instanceof MongoError &&
        err.hasErrorLabel('TransientTransactionError')
      ) {
        session.transaction.unpinServer();
      }

      // return callback.apply(null, arguments);
      if (err) {
        throw err
      }
    })

  // try {
  //   pool.write(message, commandOptions, commandResponseHandler);
  // } catch (err) {
  //   commandResponseHandler(err);
  // }
}

/** Does a topology have session support? */
function hasSessionSupport(topology: unknown): boolean {
  if (!topology) {return false;}
  
  if (topology.description) {
    return topology.description.maxWireVersion >= 6;
  }

  return topology.ismaster == null ? false : topology.ismaster.maxWireVersion >= 6;
}

/** Whether a topology or server supports op messages. */
function supportsOpMsg(topologyOrServer: unknown): boolean {
  const description: unknown = topologyOrServer.ismaster
    ? topologyOrServer.ismaster
    : topologyOrServer.description;

  if (!description) {
    return false;
  }

  return description.maxWireVersion >= 6 //&& !description.__nodejs_mock_server__;
}

// module.exports = command;
