// 'use strict';

import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const GetMore = require('../connection/commands').GetMore; GetMore 
import { GetMore } from "./../connection/commands.ts"
// const retrieveBSON = require('../connection/utils').retrieveBSON;
// import { retrieveBSON} from "./../connection/utils.ts"
// const MongoError = require('../error').MongoError;
import { MongoError, MongoNetworkError } from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const BSON = retrieveBSON();
// const Long = BSON.Long;
// const collectionNamespace = require('./shared').collectionNamespace;
import { applyCommonQueryOptions, collectionNamespace} from "./shared.ts"
// const maxWireVersion = require('../utils').maxWireVersion;
import { Callback, maxWireVersion } from "./../utils.ts"
// const applyCommonQueryOptions = require('./shared').applyCommonQueryOptions;
// const command = require('./command');
import { command } from "./command.ts"

export function getMore(server: unknown, ns: string, cursorState: unknown, batchSize: number, options: {[key:string]: any} = {}, callback: Callback): void {
  // options = options || {};

  const wireVersion: number = maxWireVersion(server);
  
  const queryCallback: Callback = (err?: Error, result: unknown): void => {
    if (err) return callback(err);
    const response = result.message;

    // If we have a timed out query or a cursor that was killed
    if (response.cursorNotFound) {
      return callback(new MongoNetworkError('cursor killed or timed out'), null);
    }

    if (wireVersion < 4) {
      const cursorId: BSON.Long =
        typeof response.cursorId === 'number'
          ? BSON.Long.fromNumber(response.cursorId)
          : response.cursorId;

      cursorState.documents = response.documents;
      cursorState.cursorId = cursorId;

      callback(null, null, response.connection);
      return;
    }

    // We have an error detected
    if (response.documents[0].ok === 0) {
      return callback(new MongoError(response.documents[0]));
    }

    // Ensure we have a Long valid cursor id
    const cursorId: BSON.Long =
      typeof response.documents[0].cursor.id === 'number'
        ? BSON.Long.fromNumber(response.documents[0].cursor.id)
        : response.documents[0].cursor.id;

    cursorState.documents = response.documents[0].cursor.nextBatch;
    cursorState.cursorId = cursorId;

    callback(null, response.documents[0], response.connection);
  }

  if (wireVersion < 4) {
    // const bson = server.s.bson;
    const getMoreOp: GetMore = new GetMore(bson, ns, cursorState.cursorId, { numberToReturn: batchSize });
    const queryOptions: {[key:string]: any} = applyCommonQueryOptions({}, cursorState);
    return server.s.pool.write(getMoreOp, queryOptions, queryCallback);
    // return;
  }

  const getMoreCmd : {[key:string]: any}= {
    getMore: cursorState.cursorId,
    collection: collectionNamespace(ns),
    batchSize: Math.abs(batchSize)
  };

  if (cursorState.cmd.tailable && typeof cursorState.cmd.maxAwaitTimeMS === 'number') {
    getMoreCmd.maxTimeMS = cursorState.cmd.maxAwaitTimeMS;
  }

  const commandOptions: {[key:string]: any} =     {
        returnFieldSelector: null,
        documentsReturnedIn: 'nextBatch',
        ...options
      }

  command(server, ns, getMoreCmd, commandOptions, queryCallback);
}