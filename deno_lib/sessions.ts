// 'use strict';
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
  import { EventEmitter } from "https://denopkg.com/balou9/EventEmitter/mod.ts"
// const retrieveBSON = require('./connection/utils').retrieveBSON;
// const EventEmitter = require('events');
// const BSON = retrieveBSON();
// const Binary = BSON.Binary;
// const uuidV4 = require('./utils').uuidV4;
import { Callback, equal, noop, uuidV4} from "./utils.ts"
import { CommandResult} from "./connection/command_result.ts"
// const MongoError = require('./error').MongoError;
// const isRetryableError = require('././error').isRetryableError;
// const MongoNetworkError = require('./error').MongoNetworkError;
// const MongoWriteConcernError = require('./error').MongoWriteConcernError;
import {MongoError, MongoNetworkError, MongoWriteConcernError, isRetryableError} from "./errors.ts"
// const Transaction = require('./transactions').Transaction;
import {TxnState, Transaction, isTransactionCommand} from "./transactions.ts"
import {Topology} from "./sdam/topology.ts"
// const TxnState = require('./transactions').TxnState;
// const isPromiseLike = require('./utils').isPromiseLike;
// const ReadPreference = require('./topologies/read_preference');
import {ReadPreference} from ".topologies/read_preference.ts"
// const isTransactionCommand = require('./transactions').isTransactionCommand;
// import {isTransactionCommand} from "./transactions.ts"
// const resolveClusterTime = require('./topologies/shared').resolveClusterTime;
import { resolveClusterTime} from "./topologies/shared.ts"
import {Cursor} from "./cursor.ts"
import { ReadConcern, WriteConcern} from "./transactions.ts"

export {TxnState} from "./transactions.ts"

function assertAlive(session: Session, callback?: Callback) : boolean{
  if (!session.serverSession) {
    const error: MongoError = new MongoError('Cannot use a session that has ended');

    if (typeof callback === 'function') {
      callback(error, null);

      return false;
    }

    throw error;
  }

  return true;
}

/**
 * Options to pass when creating a Client Session
 * @typedef {Object} SessionOptions
 * @property {boolean} [causalConsistency=true] Whether causal consistency should be enabled on this session
 * @property {TransactionOptions} [defaultTransactionOptions] The default TransactionOptions to use for transactions started on this session.
 */

/**
 * A BSON document reflecting the lsid of a {@link ClientSession}
 * @typedef {Object} SessionId
 */

/**
 * A class representing a client session on the server
 * WARNING: not meant to be instantiated directly.
 * @class
 * @hideconstructor
 */
export class ClientSession extends EventEmitter {
  // /**
  //  * Create a client session.
  //  * WARNING: not meant to be instantiated directly
  //  *
  //  * @param {Topology} topology The current client's topology (Internal Class)
  //  * @param {ServerSessionPool} sessionPool The server session pool (Internal Class)
  //  * @param {SessionOptions} [options] Optional settings
  //  * @param {Object} [clientOptions] Optional settings provided when creating a client in the porcelain driver
  //  */

  topology: Topology
  sessionPool: SessionPool
  hasEnded: boolean
  serverSession: ServerSession
  clientOptions: {[key:string]:any}
  supports: {[key:string]: any}
  clusterTime: BSON.Long
  operationTime: BSON.Timestamp
  explicit: boolean
  owner: Cursor
  defaultTransactionOptions:{[key:string]:any}
  transaction: Transaction


  /** Creates a client session. */
  constructor(topology: Topology, sessionPool:SessionPool, options:{[key:string]:any}={}, clientOptions:{[key:string]:any}={}) {
    super();

    if (!topology) {
      throw new Error('ClientSession requires a topology');
    }

    if (!sessionPool || !(sessionPool instanceof ServerSessionPool)) {
      throw new Error('ClientSession requires a ServerSessionPool');
    }

    // options = options || {};
    this.topology = topology;
    this.sessionPool = sessionPool;
    this.hasEnded = false;
    this.serverSession = sessionPool.acquire();
    this.clientOptions = clientOptions;

    this.supports = {
      causalConsistency:
         options.causalConsistency ? options.causalConsistency : true
    };

    // options = options || {};
    if (options.initialClusterTime) {
      this.clusterTime = options.initialClusterTime;
    } else {
      this.clusterTime = null;
    }

    this.operationTime = null;
    this.explicit = !!options.explicit;
    this.owner = options.owner;
    this.defaultTransactionOptions = { ...options.defaultTransactionOptions}
    this.transaction = new Transaction();
  }

  /** The server id associated with this session. */
  get id(): { id: Uint8Array} {
    return this.serverSession.id;
  }

  /**
   * Ends this session on the server
   *
   * @param {Object} [options] Optional settings. Currently reserved for future use
   * @param {Function} [callback] Optional callback for completion of this operation
   */
  endSession(options: any={}, callback:Callback=noop): void {
    if (typeof options === 'function') {
      // (callback = options), (options = {});
      callback =options
      options={}
    }
    // options = options || {};

    if (this.hasEnded) {
      // if (typeof callback === 'function') callback(null, null);
      // return;
      return callback(null, null);
    }

    if (this.serverSession && this.inTransaction()) {
      this.abortTransaction(); // pass in callback?
    }

    // mark the session as ended, and emit a signal
    this.hasEnded = true;
    this.emit('ended', this);

    // release the server session back to the pool
    this.sessionPool.release(this.serverSession);
    this.serverSession = null;

    // spec indicates that we should ignore all errors for `endSessions`
    // if (typeof callback === 'function') callback(null, null);
    callback(null, null);
  }

  /**
   * Advances the operationTime for a ClientSession.
   *
   * @param {Timestamp} operationTime the `BSON.Timestamp` of the operation type it is desired to advance to
   */
  advanceOperationTime(operationTime: BSON.Timestamp): void {
    if (!this.operationTime) {
      this.operationTime = operationTime;
      return;
    }

    if (operationTime.greaterThan(this.operationTime)) {
      this.operationTime = operationTime;
    }
  }

  /**
   * Used to determine if this session equals another
   * @param {ClientSession} session
   * @return {boolean} true if the sessions are equal
   */
  equals(session: ClientSession):boolean {
    if (!(session instanceof ClientSession)) {
      return false;
    }

    // TODO: equality comparison
    // return this.id.id.buffer.equals(session.id.id.buffer);
    return equal(this.id.id, session.id.id)
  }

  /** Increment the transaction number on the internal ServerSession. */
  incrementTransactionNumber() {
    this.serverSession.txnNumber++;
  }

  /** Whether this session is currently in a transaction or not. */
  inTransaction(): boolean {
    return this.transaction.isActive;
  }

  /** Starts a new transaction with the given options. */
  startTransaction(options:{[key:string]:any}): void {
    assertAlive(this);
    if (this.inTransaction()) {
      throw new MongoError('Transaction already in progress');
    }

    // increment txnNumber
    this.incrementTransactionNumber();

    // create transaction state
    this.transaction = new Transaction(
      // Object.assign({}, this.clientOptions, options || this.defaultTransactionOptions)
      { ...this.clientOptions, ...(options || this.defaultTransactionOptions)}
    );

    this.transaction.transition(TxnState.STARTING_TRANSACTION);
  }

  /**
   * Commits the currently active transaction in this session.
   *
   * @param {Function} [callback] optional callback for completion of this operation
   * @return {Promise} A promise is returned if no callback is provided
   */
  commitTransaction(callback: Callback = noop): void | Promise<CommandResult> {
    if (typeof callback === 'function') {
      return endTransaction(this, 'commitTransaction', callback);
      // return;
    }

    return new Promise((resolve: (reply?:CommandResult) => void, reject: (err?:Error) => void): void => {
      endTransaction(
        this,
        'commitTransaction',
        (err?: Error, reply?: CommandResult): void => (err ? reject(err) : resolve(reply))
      );
    });
  }

  /**
   * Aborts the currently active transaction in this session.
   *
   * @param {Function} [callback] optional callback for completion of this operation
   * @return {Promise} A promise is returned if no callback is provided
   */
  abortTransaction(callback: Callback = noop): void | Promise<CommandResult>  {
    if (typeof callback === 'function') {
      return endTransaction(this, 'abortTransaction', callback);
      // return;
    }

    return new Promise((resolve: (reply?:CommandResult) => void, reject: (err?:Error) => void): void => {
      endTransaction(
        this,
        'abortTransaction',
        (err?: Error, reply?: CommandResult): void => (err ? reject(err) : resolve(reply))
      );
    });
  }

  /** This is here to ensure that ClientSession is never serialized to BSON. */
  toBSON() {
    throw new MongoError('ClientSession cannot be serialized to BSON.');
  }

  /**
   * A user provided function to be run within a transaction
   *
   * @callback WithTransactionCallback
   * @param {ClientSession} session The parent session of the transaction running the operation. This should be passed into each operation within the lambda.
   * @returns {Promise} The resulting Promise of operations run within this transaction
   */

  /**
   * Runs a provided lambda within a transaction, retrying either the commit operation
   * or entire transaction as needed (and when the error permits) to better ensure that
   * the transaction can complete successfully.
   *
   * IMPORTANT: This method requires the user to return a Promise, all lambdas that do not
   * return a Promise will result in undefined behavior.
   *
   * @param {WithTransactionCallback} fn
   * @param {TransactionOptions} [options] Optional settings for the transaction
   */
  withTransaction(fn: (...args:any[]) => Promise<any>, options:{[key:string]:any} ={} ):Promise<void> {
    const startTime: number = performance.now();
    return attemptTransaction(this, startTime, fn, options);
  }
}

const MAX_WITH_TRANSACTION_TIMEOUT: number = 120000;
const UNSATISFIABLE_WRITE_CONCERN_CODE: number = 100;
const UNKNOWN_REPL_WRITE_CONCERN_CODE: number = 79;
const NON_DETERMINISTIC_WRITE_CONCERN_ERRORS: Set<string> = new Set([
  'CannotSatisfyWriteConcern',
  'UnknownReplWriteConcern',
  'UnsatisfiableWriteConcern'
]);

/** Determines whether somthing has timed out by start and max timestamps. */
function hasNotTimedOut(startTime: number, max: number): boolean {
  return Date.now() - startTime < max;
}

/** Does a mongo error indicate an unknown transaction commit result? */
function isUnknownTransactionCommitResult(err: MongoError): boolean {
  return (
    !NON_DETERMINISTIC_WRITE_CONCERN_ERRORS.has(err.codeName) &&
    err.code !== UNSATISFIABLE_WRITE_CONCERN_CODE &&
    err.code !== UNKNOWN_REPL_WRITE_CONCERN_CODE
  );
}

/** Attempts a transaction commit. */
function attemptTransactionCommit(session: ClientSession, startTime: number, fn?: never, options?: never): Promise<void> {
const promise: Promise<CommandResult> = session.commitTransaction() as Promise<CommandResult>

  return promise.catch((err: MongoError): Promise<void> => {
    if (err instanceof MongoError && hasNotTimedOut(startTime, MAX_WITH_TRANSACTION_TIMEOUT)) {
      if (err.hasErrorLabel('UnknownTransactionCommitResult')) {
        return attemptTransactionCommit(session, startTime, fn, options);
      }

      if (err.hasErrorLabel('TransientTransactionError')) {
        return attemptTransaction(session, startTime, fn, options);
      }
    }

    throw err;
  });
}

const USER_EXPLICIT_TXN_END_STATES: Set<string> = new Set([
  TxnState.NO_TRANSACTION,
  TxnState.TRANSACTION_COMMITTED,
  TxnState.TRANSACTION_ABORTED
]);

/** Did a user explicitely end a session? */
function userExplicitlyEndedTransaction(session: ClientSession): boolean {
  return USER_EXPLICIT_TXN_END_STATES.has(session.transaction.state);
}

/** Attempts a transaction. */
function attemptTransaction(session: ClientSession, startTime: number, fn: (...args:any[]) => Promise<any>, options: {[key:string]:any}={}): Promise<CommandResult> {
  session.startTransaction(options);

  let promise: Promise<CommandResult>;

  try {
    promise = fn(session);
  } catch (err) {
    promise = Promise.reject(err);
  }

  // if (!isPromiseLike(promise)) {
  if (!(promise instanceof Promise)) {
    session.abortTransaction();
    throw new TypeError('Function provided to `withTransaction` must return a Promise');
  }

  return promise
    .then(async (): Promise<void> => {
      if (userExplicitlyEndedTransaction(session)) {
        return;
      }

      return attemptTransactionCommit(session, startTime/*, fn, options*/);
    })
    .catch(async (err?:Error ): Promise<void>=> {
      function maybeRetryOrThrow(err: MongoError): Promise<void> {
        if (
          err instanceof MongoError &&
          err.hasErrorLabel('TransientTransactionError') &&
          hasNotTimedOut(startTime, MAX_WITH_TRANSACTION_TIMEOUT)
        ) {
          return attemptTransaction(session, startTime, fn, options);
        }

        throw err;
      }

      if (session.transaction.isActive) {
        const promise: Promise<CommandResult> = session.abortTransaction() as Promise<CommandResult>
        return promise.then(():  Promise<void> => maybeRetryOrThrow(err));
      }

      return maybeRetryOrThrow(err);
    });
}

/** Ends a transaction. */
function endTransaction(session: ClientSession, commandName: string, callback: Callback=noop): void {
  if (!assertAlive(session, callback)) {
    // checking result in case callback was called
    return;
  }

  // handle any initial problematic cases
  let txnState: string = session.transaction.state;

  if (txnState === TxnState.NO_TRANSACTION) {
    return callback(new MongoError('No transaction started'));
    // return;
  }

  if (commandName === 'commitTransaction') {
    if (
      txnState === TxnState.STARTING_TRANSACTION ||
      txnState === TxnState.TRANSACTION_COMMITTED_EMPTY
    ) {
      // the transaction was never started, we can safely exit here
      session.transaction.transition(TxnState.TRANSACTION_COMMITTED_EMPTY);
      return callback(null, null);
      // return;
    }

    if (txnState === TxnState.TRANSACTION_ABORTED) {
      return callback(new MongoError('Cannot call commitTransaction after calling abortTransaction'));
      // return;
    }
  } else {
    if (txnState === TxnState.STARTING_TRANSACTION) {
      // the transaction was never started, we can safely exit here
      session.transaction.transition(TxnState.TRANSACTION_ABORTED);
      return callback(null, null);
      // return;
    }

    if (txnState === TxnState.TRANSACTION_ABORTED) {
      return callback(new MongoError('Cannot call abortTransaction twice'));
      // return;
    }

    if (
      txnState === TxnState.TRANSACTION_COMMITTED ||
      txnState === TxnState.TRANSACTION_COMMITTED_EMPTY
    ) {
      return callback(new MongoError('Cannot call abortTransaction after calling commitTransaction'));
      // return;
    }
  }

  // construct and send the command
  const command: {[key:string]:any} = { [commandName]: 1 };

  // apply a writeConcern if specified
  let writeConcern: WriteConcern;

  if (session.transaction.options.writeConcern) {
    // writeConcern = Object.assign({}, session.transaction.options.writeConcern);
    writeConcern = {...session.transaction.options.writeConcern}
  } else if (session.clientOptions && session.clientOptions.w) {
    writeConcern = { w: session.clientOptions.w };
  }

  if (txnState === TxnState.TRANSACTION_COMMITTED) {
    // writeConcern = Object.assign({ wtimeout: 10000 }, writeConcern, { w: 'majority' });
    writeConcern = {wtimeout: 10000, ...writeConcern, w: "majority"}
  }

  if (writeConcern) {
    // Object.assign(command, { writeConcern });
    command.writeConcern = writeConcern
  }

  function commandHandler(err?:MongoError, r?:CommandResult): void {
    if (commandName === 'commitTransaction') {
      session.transaction.transition(TxnState.TRANSACTION_COMMITTED);

      if (
        err &&
        (err instanceof MongoNetworkError ||
          err instanceof MongoWriteConcernError ||
          isRetryableError(err))
      ) {
        if (err.errorLabels) {
          const idx = err.errorLabels.indexOf('TransientTransactionError');
          if (idx !== -1) {
            err.errorLabels.splice(idx, 1);
          }
        } else {
          err.errorLabels = [];
        }

        if (isUnknownTransactionCommitResult(err)) {
          err.errorLabels.push('UnknownTransactionCommitResult');

          // per txns spec, must unpin session in this case
          session.transaction.unpinServer();
        }
      }
    } else {
      session.transaction.transition(TxnState.TRANSACTION_ABORTED);
    }

    callback(err, r);
  }

  // The spec indicates that we should ignore all errors on `abortTransaction`
  function transactionError(err: MongoError): MongoError {
    return commandName === 'commitTransaction' ? err : null;
  }

  if (
    // Assumption here that commandName is "commitTransaction" or "abortTransaction"
    session.transaction.recoveryToken &&
    supportsRecoveryToken(session)
  ) {
    command.recoveryToken = session.transaction.recoveryToken;
  }

  // send the command
  session.topology.command('admin.$cmd', command, { session }, (err?:MongoError, reply?:CommandResult):void => {
    if (err && isRetryableError(err)) {
      // SPEC-1185: apply majority write concern when retrying commitTransaction
      if (command.commitTransaction) {
        // per txns spec, must unpin session in this case
        session.transaction.unpinServer();

        command.writeConcern =
        // Object.assign({ wtimeout: 10000 }, command.writeConcern, {
        //   w: 'majority'
        // });
        { wtimeout: 10000, ...command.writeConcern, w:"majority"}
      }

      return session.topology.command('admin.$cmd', command, { session }, (_err?: MongoError, _reply?:CommandResult):void =>
        commandHandler(transactionError(_err), _reply)
      );
    }

    commandHandler(transactionError(err), reply);
  });
}

/** Whether a client session supports recovery tokens. */
function supportsRecoveryToken(session: ClientSession): boolean {
  const topology: Topology = session.topology;
  return !!topology.s.options.useRecoveryToken;
}

/**
 * Reflects the existence of a session on the server. Can be reused by the session pool.
 * WARNING: not meant to be instantiated directly. For internal use only.
 * @ignore
 */
export class ServerSession {
  id: { id: Uint8Array }
  lastUse: number
  txnNumber: number

  /** Creates a server session representation. */
  constructor() {
    // this.id = { id: new BSON.Binary(uuidV4(), BSON.Binary.SUBTYPE_UUID) };
    this.id={id: uuidV4()}
    this.lastUse = Date.now();
    this.txnNumber = 0;
  }

  /** Determines if the server session has timed out. */
  hasTimedOut(sessionTimeoutMinutes: number): boolean {
    // Take the difference of the lastUse timestamp and now, which will result in a value in
    // milliseconds, and then convert milliseconds to minutes to compare to `sessionTimeoutMinutes`
    const idleTimeMinutes: number = Math.round(
      (((Date.now() - this.lastUse) % 86400000) % 3600000) / 60000
    );

    return idleTimeMinutes > sessionTimeoutMinutes - 1;
  }
}

/**
 * Maintains a pool of Server Sessions.
 * For internal use only
 * @ignore
 */
export class ServerSessionPool {
  topology: Topology
  sessions: ServerSession[]

  /** Creates a server session pool. */
  constructor(topology: Topology) {
    if (!topology) {
      throw new Error('ServerSessionPool requires a topology');
    }

    this.topology = topology;
    this.sessions = [];
  }

  /** Ends all sessions in the session pool. */
  endAllPooledSessions(): void {
    if (this.sessions.length) {
      this.topology.endSessions(this.sessions.map((session: ServerSession): { id: Uint8Array} => session.id));
      this.sessions = [];
    }
  }

  /**
   * Acquire a Server Session from the pool.
   * Iterates through each session in the pool, removing any stale sessions
   * along the way. The first non-stale session found is removed from the
   * pool and returned. If no non-stale session is found, a new ServerSession
   * is created.
   * @ignore
   * @returns {ServerSession}
   */
  acquire(): ServerSession {
    const sessionTimeoutMinutes: number = this.topology.logicalSessionTimeoutMinutes;

    while (this.sessions.length) {
      const session:ServerSession = this.sessions.shift();

      if (!session.hasTimedOut(sessionTimeoutMinutes)) {
        return session;
      }
    }

    return new ServerSession();
  }

  /**
   * Release a session to the session pool
   * Adds the session back to the session pool if the session has not timed out yet.
   * This method also removes any stale sessions from the pool.
   * @ignore
   * @param {ServerSession} session The session to release to the pool
   */
  release(session: ServerSession): void {
    const sessionTimeoutMinutes: number = this.topology.logicalSessionTimeoutMinutes;

    while (this.sessions.length) {
      const session: ServerSession = this.sessions[this.sessions.length - 1];

      if (session.hasTimedOut(sessionTimeoutMinutes)) {
        this.sessions.pop();
      } else {
        break;
      }
    }

    if (!session.hasTimedOut(sessionTimeoutMinutes)) {
      this.sessions.unshift(session);
    }
  }
}

/**
 * Optionally decorate a command with sessions specific keys
 *
 * @param {ClientSession} session the session tracking transaction state
 * @param {Object} command the command to decorate
 * @param {Object} topology the topology for tracking the cluster time
 * @param {Object} [options] Optional settings passed to calling operation
 * @return {MongoError|null} An error, if some error condition was met
 */
export function applySession(session: ClientSession, command: {[key:string]:any}, options: {[key:string]:any}={}): void {
  const serverSession: ServerSession = session.serverSession;

  if (!serverSession) {
    // TODO: merge this with `assertAlive`, did not want to throw a try/catch here
    return new MongoError('Cannot use a session that has ended');
  }

  // mark the last use of this session, and apply the `lsid`
  serverSession.lastUse = Date.now();
  command.lsid = serverSession.id;

  // first apply non-transaction-specific sessions data
  const inTransaction: boolean = session.inTransaction() || isTransactionCommand(command);
  const isRetryableWrite: boolean = options.willRetryWrite;

  if (serverSession.txnNumber && (isRetryableWrite || inTransaction)) {
    command.txnNumber = BSON.Long.fromNumber(serverSession.txnNumber);
  }

  // now attempt to apply transaction-specific sessions data
  if (!inTransaction) {
    if (session.transaction.state !== TxnState.NO_TRANSACTION) {
      session.transaction.transition(TxnState.NO_TRANSACTION);
    }

    // TODO: the following should only be applied to read operation per spec.
    // for causal consistency
    if (session.supports.causalConsistency && session.operationTime) {
      command.readConcern = command.readConcern || {};
      // Object.assign(command.readConcern, { afterClusterTime: session.operationTime });
      command.readConcern.afterClusterTime = session.operationTime
    }

    return;
  }

  if (options.readPreference && !options.readPreference.equals(ReadPreference.primary)) {
    return new MongoError(
      `Read preference in a transaction must be primary, not: ${options.readPreference.mode}`
    );
  }

  // `autocommit` must always be false to differentiate from retryable writes
  command.autocommit = false;

  if (session.transaction.state === TxnState.STARTING_TRANSACTION) {
    session.transaction.transition(TxnState.TRANSACTION_IN_PROGRESS);
    command.startTransaction = true;

    const readConcern: ReadConcern =
      session.transaction.options.readConcern || session.clientOptions.readConcern;
    if (readConcern) {
      command.readConcern = readConcern;
    }

    if (session.supports.causalConsistency && session.operationTime) {
      command.readConcern = command.readConcern || {};
      // Object.assign(command.readConcern, { afterClusterTime: session.operationTime });
      command.readConcern.afterClusterTime = session.operationTime
    }
  }
}

export function updateSessionFromResponse(session: ClientSession, document: {[key:string]: any}): void {
  if (document.$clusterTime) {
    resolveClusterTime(session, document.$clusterTime);
  }

  if (document.operationTime && session && session.supports.causalConsistency) {
    session.advanceOperationTime(document.operationTime);
  }

  if (document.recoveryToken && session && session.inTransaction()) {
    session.transaction._recoveryToken = document.recoveryToken;
  }
}

// module.exports = {
//   ClientSession,
//   ServerSession,
//   ServerSessionPool,
//   TxnState,
//   applySession,
//   updateSessionFromResponse
// };
