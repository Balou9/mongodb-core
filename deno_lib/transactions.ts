// 'use strict';
// const MongoError = require('./error').MongoError;
//
// let TxnState;
// let stateMachine;

import { MongoError } from "./errors.ts";

export function isTransactionCommand(command: any) {
  return !!(command.commitTransaction || command.abortTransaction);
}

// (() => {
  const NO_TRANSACTION: string = 'NO_TRANSACTION';
  const STARTING_TRANSACTION: string = 'STARTING_TRANSACTION';
  const TRANSACTION_IN_PROGRESS: string = 'TRANSACTION_IN_PROGRESS';
  const TRANSACTION_COMMITTED: string = 'TRANSACTION_COMMITTED';
  const TRANSACTION_COMMITTED_EMPTY: string = 'TRANSACTION_COMMITTED_EMPTY';
  const TRANSACTION_ABORTED: string = 'TRANSACTION_ABORTED';

  export const TxnState: { [key: string]: string} = {
    NO_TRANSACTION,
    STARTING_TRANSACTION,
    TRANSACTION_IN_PROGRESS,
    TRANSACTION_COMMITTED,
    TRANSACTION_COMMITTED_EMPTY,
    TRANSACTION_ABORTED
  };

const   stateMachine: { [key: string]: string[]} = {
    [NO_TRANSACTION]: [NO_TRANSACTION, STARTING_TRANSACTION],
    [STARTING_TRANSACTION]: [
      TRANSACTION_IN_PROGRESS,
      TRANSACTION_COMMITTED,
      TRANSACTION_COMMITTED_EMPTY,
      TRANSACTION_ABORTED
    ],
    [TRANSACTION_IN_PROGRESS]: [
      TRANSACTION_IN_PROGRESS,
      TRANSACTION_COMMITTED,
      TRANSACTION_ABORTED
    ],
    [TRANSACTION_COMMITTED]: [
      TRANSACTION_COMMITTED,
      TRANSACTION_COMMITTED_EMPTY,
      STARTING_TRANSACTION,
      NO_TRANSACTION
    ],
    [TRANSACTION_ABORTED]: [STARTING_TRANSACTION, NO_TRANSACTION],
    [TRANSACTION_COMMITTED_EMPTY]: [TRANSACTION_COMMITTED_EMPTY, NO_TRANSACTION]
  };
// })();



/**
 * The MongoDB ReadConcern, which allows for control of the consistency and
 * isolation properties of the data read from replica sets and shards.
 * level values: 'local'|'available'|'majority'|'linearizable'|'snapshot'.
 * See https://docs.mongodb.com/manual/reference/read-concern/
 */
 export interface ReadConcern {
   level: string;
 }

/**
 * A MongoDB WriteConcern, which describes the level of acknowledgement
 * requested from MongoDB for write operations.
 * param w requests acknowledgement that the write operation has
 * propagated to a specified number of mongod hosts; default 1.
 * param j requests acknowledgement from MongoDB that the write operation has
 * been written to the journal; default false.
 * wtimeout sets a time limit, in milliseconds, for the write concern.
 * See https://docs.mongodb.com/manual/reference/write-concern/
 */
export interface WriteConcern {
  w?: number | string;
  j?: boolean;
  wtimeout?: number;
}

/**
 * Configuration options for a transaction.
 * Given concern preference defaults for commands in a transaction.
 */
export interface TransactionOptions {
  readConcern?: ReadConcern;
  writeConcern?: WriteConcern;
  readPreference?: unknown;
}

/** A class maintaining state related to a server transaction. Internal Only. */
export class Transaction {
  state: string;
  options: TransactionOptions;

  private _pinnedServer: unknown;
  private _recoveryToken: unknown;

  /** Creates a transaction. */
  constructor(options: TransactionOptions = { readConcern: { level: "local" }, writeConcern: { w: 1, j: false, wtimeout: 0 } }) {
    options = options || {};

    this.state = TxnState.NO_TRANSACTION;
    this.options = options;

    if (options.writeConcern) {
      if (options.writeConcern.w < 1) {
        throw new MongoError('Transactions do not support unacknowledged write concerns');
      }

      this.options.writeConcern = { w: 1, j: false, wtimeout: 0, ...options.writeConcern }//options.writeConcern;
    }

    if (options.readConcern) {this.options.readConcern = { level: "local", ...options.readConcern};}

    if (options.readPreference) {this.options.readPreference = {...options.readPreference};}

    // // TODO: This isn't technically necessary
    // this._pinnedServer = undefined;
    // this._recoveryToken = undefined;
  }

  /** Transition the transaction in the state machine. */
  transition(nextState: string): void {
    const nextStates: string [] = stateMachine[this.state];
    if (nextStates && nextStates.indexOf(nextState) !== -1) {
      this.state = nextState;
      if (this.state === TxnState.NO_TRANSACTION || this.state === TxnState.STARTING_TRANSACTION) {
        this.unpinServer();
      }
      return;
    }

    throw new MongoError(
      `Attempted illegal state transition from [${this.state}] to [${nextState}]`
    );
  }

  /** Pins a server. */
  pinServer(server: unknown): void {
    if (this.isActive) {
      this._pinnedServer = server;
    }
  }

  /** Unpins a server. */
  unpinServer(): void {
    this._pinnedServer = undefined;
  }

  /** Gets the pinned server. */
  get server(): unknown {
    return this._pinnedServer;
  }

  /** Gets the recovery token. */
  get recoveryToken(): unknown {
    return this._recoveryToken;
  }

  /** Whether this transaction is pinned. */
  get isPinned(): boolean {
    return !!this.server;
  }

  /** Whether this is a transaction about to start or in progress. */
  get isActive(): boolean {
    return (
      [TxnState.STARTING_TRANSACTION, TxnState.TRANSACTION_IN_PROGRESS].indexOf(this.state) !== -1
    );
  }
}

// module.exports = { TxnState, Transaction, isTransactionCommand };
