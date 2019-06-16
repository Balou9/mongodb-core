// 'use strict';

export const mongoErrorContextSymbol: Symbol = Symbol('mongoErrorContextSymbol');

/** A class rerpresentation of a generic mongodb error. */
export class MongoError extends Error {
  readonly stack: string;
    
  name: string = "MongoError";
  mongoErrorContextSymbol: { [key:string]: any} = {};
  errorLabels: string[];
    
  /** Creates a new MongoError. */
  constructor(message: string | Error | { message: string, stack: string }) {
    super(typeof message === "string" ? message : message.message)
    this.stack = typeof message === "string" ? "" : message.stack

    // this.name = 'MongoError';
    // this[mongoErrorContextSymbol] = this[mongoErrorContextSymbol] || {};
  }

  // /**
  //  * Creates a new MongoError object
  //  *
  //  * @param {Error|string|object} options The options used to create the error.
  //  * @return {MongoError} A MongoError instance
  //  * @deprecated Use `new MongoError()` instead.
  //  */
  // static create(options) {
  //   return new MongoError(options);
  // }

  /** Checks whether given label is attached to this error instance. */
  hasErrorLabel(label: string): boolean {
    return this.errorLabels && this.errorLabels.indexOf(label) !== -1;
  }
}

/** Creates a new MongoNetworkError. */
export class MongoNetworkError extends MongoError {
  constructor(message: string | Error | { message: string, stack: string }) {
    super(message);
    this.name = 'MongoNetworkError';

    // This is added as part of the transactions specification
    this.errorLabels = ['TransientTransactionError'];
  }
}

/** An error used when attempting to parse a value (fx a connection string). */
export class MongoParseError extends MongoError {
  constructor(message: string | Error | { message: string, stack: string }) {
    super(message);
    this.name = 'MongoParseError';
  }
}

/** An error signifying a timeout event. */
export class MongoTimeoutError extends MongoError {
  constructor(message: string | Error | { message: string, stack: string }) {
    super(message);
    this.name = 'MongoTimeoutError';
  }
}

function makeWriteConcernResultObject(input: { [key:string]: any}):{ [key:string]: any} {
  const output: { [key:string]: any} = { ...input }

  if (output.ok === 0) {
    output.ok = 1;
    delete output.errmsg;
    delete output.code;
    delete output.codeName;
  }

  return output;
}

/**
 * An error thrown when the server reports a writeConcernError
 * Param result can be a result document (provided if ok: 1).
 */
export class MongoWriteConcernError extends MongoError {
  readonly result: { [key:string]: any};
  
  constructor(message: string | Error | { message: string, stack: string }, result?: { [key:string]: any}) {
    super(message);
    this.name = 'MongoWriteConcernError';

    if (result) {
      this.result = makeWriteConcernResultObject(result);
    }
  }
}

// see: https://github.com/mongodb/specifications/blob/master/source/retryable-writes/retryable-writes.rst#terms
const RETRYABLE_ERROR_CODES: Set<number> = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  9001, // SocketException
  10107, // NotMaster
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotMasterNoSlaveOk
  13436 // NotMasterOrSecondary
]);

/** Determines whether an error is sth the driver should attempt to retry. */
export function isRetryableError(error: any): boolean {
  return (
    error &&
    RETRYABLE_ERROR_CODES.has(error.code) ||
    error instanceof MongoNetworkError ||
    error.message.match(/not master/) ||
    error.message.match(/node is recovering/)
  );
}

// module.exports = {
//   MongoError,
//   MongoNetworkError,
//   MongoParseError,
//   MongoTimeoutError,
//   MongoWriteConcernError,
//   mongoErrorContextSymbol,
//   isRetryableError
// };