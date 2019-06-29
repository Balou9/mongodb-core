// 'use strict';

// const KillCursor = require('../connection/commands').KillCursor;
import { KillCursor} from "./../connection/commands.ts"
// const MongoError = require('../error').MongoError;
import { MongoError, MongoNetworkError } from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const collectionNamespace = require('./shared').collectionNamespace;
import { collectionNamespace } from "./shared.ts"
// const maxWireVersion = require('../utils').maxWireVersion;
import {maxWireVersion} from "./../utils.ts"
// const command = require('./command');
import { command } from "./command.ts"
import { Callback} from "./../utils.ts"

function noop(): void {}

export function killCursors(server: unknown, ns:string, cursorState: unknown, callback: Callback = noop): void {
  // callback = typeof callback === 'function' ? callback : () => {};
  const cursorId: unknown = cursorState.cursorId;

  if (maxWireVersion(server) < 4) {
    // const bson = server.s.bson;
    const pool: Pool = server.s.pool;
    const killCursor: KillCursor = new KillCursor(/*bson, */ns, [cursorId]);
    const options: {[key:string]: any} = {
      immediateRelease: true,
      noResponse: true
    };

    if (typeof cursorState.session === 'object') {
      options.session = cursorState.session;
    }

    if (pool && pool.isConnected()) {
      try {
        pool.write(killCursor, options, callback);
      } catch (err) {
        if (typeof callback === 'function') {
          callback(err, null);
        } else {
          console.warn(err);
        }
      }
    }

    return;
  }

  const killCursorCmd: {[key:string]: any} = {
    killCursors: collectionNamespace(ns),
    cursors: [cursorId]
  };

  const options: {[key:string]: any} = {};
  
  if (typeof cursorState.session === 'object') options.session = cursorState.session;

  command(server, ns, killCursorCmd, options, (err: Error, result: unknown): any => {
    if (err) {
      return callback(err);
    }

    const response: unknown = result.message;
    
    if (response.cursorNotFound) {
      return callback(new MongoNetworkError('cursor killed or timed out'), null);
    }

    if (!Array.isArray(response.documents) || response.documents.length === 0) {
      return callback(
        new MongoError(`invalid killCursors result returned for cursor id ${cursorId}`)
      );
    }

    callback(null, response.documents[0]);
  });
}

// module.exports = killCursors;
