// 'use strict';
// 
// var f = require('util').format,
//   MongoError = require('../error').MongoError;

import { MongoError } from "./../errors.ts";

export interface LoggerOptions {
  logger?: (...args: any[]) => void;
  loggerLevel?: string
}

export class Logger {
  static classFilters: {[key:string]: boolean} = {};
  static filteredClasses: unknown = {};
  static level: unknown = null;
  static pid: number = NaN;
  static currentLogger: (...args: any[]) => void = null;
  
  readonly className: string;
  
  constructor(className: string, { logger= console.log, loggerLevel= "error" }: LoggerOptions = {}) {
    this.className = className;
    
    Logger.currentLogger = logger
    Logger.level = loggerLevel;
    
      if (!filteredClasses[this.className]){ classFilters[this.className] = true;}
  }
  
  
  
  
  /** Log a message at the debug level. */
  debug(message: string, object?: {[key:string]: any}): void {
    if (
      this.isDebug() 
 // &&      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
 //        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      const filteredClassesKeysLength: number = Object.keys(filteredClasses).length
      

      if (      filteredClassesKeysLength && filteredClasses[this.className] ||
              !filteredClassesKeysLength && classFilters[this.className]) {
        // var dateTime = new Date().getTime();
        const dateTime: number = Date.now()
        // var msg = f('[%s-%s:%s] %s %s', 'DEBUG', this.className, pid, dateTime, message);
        const msg: string = `[DEBUG-${this.className}:${Logger.pid}] ${dateTime} ${message}`
        
        const state: {[key:string]: any} = {
          type: 'debug',
          message: message,
          className: this.className,
          pid: pid,
          date: dateTime
        };
        
        if (object) {state.meta = object;}
        
        currentLogger(msg, state);
      }
    }
  }
  
  /** Log a message at the warn level. */
  warn(message: string, object?: {[key:string]: any}): void {
    if (
      this.isWarn()
 // &&      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
 //        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      const filteredClassesKeysLength: number = Object.keys(filteredClasses).length
      

      if (      filteredClassesKeysLength && filteredClasses[this.className] ||
              !filteredClassesKeysLength && classFilters[this.className]) {
        // var dateTime = new Date().getTime();
        const dateTime: number = Date.now()
        // var msg = f('[%s-%s:%s] %s %s', 'DEBUG', this.className, pid, dateTime, message);
        const msg: string = `[WARN-${this.className}:${Logger.pid}] ${dateTime} ${message}`
        
        const state: {[key:string]: any} = {
          type: 'warn',
          message: message,
          className: this.className,
          pid: pid,
          date: dateTime
        };
        
        if (object) {state.meta = object;}
        
        currentLogger(msg, state);
      }
    }
  }
  
  /** Log a message at the info level. */
  info(message: string, object?: {[key:string]: any}): void {
    if (
      this.isInfo()
 // &&      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
 //        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      const filteredClassesKeysLength: number = Object.keys(filteredClasses).length
      

      if (      filteredClassesKeysLength && filteredClasses[this.className] ||
              !filteredClassesKeysLength && classFilters[this.className]) {
        // var dateTime = new Date().getTime();
        const dateTime: number = Date.now()
        // var msg = f('[%s-%s:%s] %s %s', 'DEBUG', this.className, pid, dateTime, message);
        const msg: string = `[INFO-${this.className}:${Logger.pid}] ${dateTime} ${message}`
        
        const state: {[key:string]: any} = {
          type: 'info',
          message: message,
          className: this.className,
          pid: pid,
          date: dateTime
        };
        
        if (object) {state.meta = object;}
        
        currentLogger(msg, state);
      }
    }
  }
  
  /** Log a message at the error level. */
  error(message: string, object?: {[key:string]: any}): void {
    if (
      this.isError()
 // &&      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
 //        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      const filteredClassesKeysLength: number = Object.keys(filteredClasses).length
      

      if (      filteredClassesKeysLength && filteredClasses[this.className] ||
              !filteredClassesKeysLength && classFilters[this.className]) {
        // var dateTime = new Date().getTime();
        const dateTime: number = Date.now()
        // var msg = f('[%s-%s:%s] %s %s', 'DEBUG', this.className, pid, dateTime, message);
        const msg: string = `[ERROR-${this.className}:${Logger.pid}] ${dateTime} ${message}`
        
        const state: {[key:string]: any} = {
          type: 'error',
          message: message,
          className: this.className,
          pid: pid,
          date: dateTime
        };
        
        if (object) {state.meta = object;}
        
        currentLogger(msg, state);
      }
    }
  }
  
  
}

// Filters for classes
var classFilters = {};
var filteredClasses = {};
var level = null;
// Save the process id
var pid = process.pid;
// current logger
var currentLogger = null;

/**
 * Creates a new Logger instance
 * @class
 * @param {string} className The Class name associated with the logging instance
 * @param {object} [options=null] Optional settings.
 * @param {Function} [options.logger=null] Custom logger function;
 * @param {string} [options.loggerLevel=error] Override default global log level.
 * @return {Logger} a Logger instance.
 */
var Logger = function(className, options) {
  if (!(this instanceof Logger)) return new Logger(className, options);
  options = options || {};

  // Current reference
  this.className = className;

  // Current logger
  if (options.logger) {
    currentLogger = options.logger;
  } else if (currentLogger == null) {
    currentLogger = console.log;
  }

  // Set level of logging, default is error
  if (options.loggerLevel) {
    level = options.loggerLevel || 'error';
  }

  // Add all class names
  if (filteredClasses[this.className] == null) classFilters[this.className] = true;
};

/**
 * Log a message at the debug level
 * @method
 * @param {string} message The message to log
 * @param {object} object additional meta data to log
 * @return {null}
 */
Logger.prototype.debug = function(message, object) {
  if (
    this.isDebug() &&
    ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
      (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
  ) {
    var dateTime = new Date().getTime();
    var msg = f('[%s-%s:%s] %s %s', 'DEBUG', this.className, pid, dateTime, message);
    var state = {
      type: 'debug',
      message: message,
      className: this.className,
      pid: pid,
      date: dateTime
    };
    if (object) state.meta = object;
    currentLogger(msg, state);
  }
};

/**
 * Log a message at the warn level
 * @method
 * @param {string} message The message to log
 * @param {object} object additional meta data to log
 * @return {null}
 */
(Logger.prototype.warn = function(message, object) {
  if (
    this.isWarn() &&
    ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
      (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
  ) {
    var dateTime = new Date().getTime();
    var msg = f('[%s-%s:%s] %s %s', 'WARN', this.className, pid, dateTime, message);
    var state = {
      type: 'warn',
      message: message,
      className: this.className,
      pid: pid,
      date: dateTime
    };
    if (object) state.meta = object;
    currentLogger(msg, state);
  }
}),
  /**
   * Log a message at the info level
   * @method
   * @param {string} message The message to log
   * @param {object} object additional meta data to log
   * @return {null}
   */
  (Logger.prototype.info = function(message, object) {
    if (
      this.isInfo() &&
      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      var dateTime = new Date().getTime();
      var msg = f('[%s-%s:%s] %s %s', 'INFO', this.className, pid, dateTime, message);
      var state = {
        type: 'info',
        message: message,
        className: this.className,
        pid: pid,
        date: dateTime
      };
      if (object) state.meta = object;
      currentLogger(msg, state);
    }
  }),
  /**
   * Log a message at the error level
   * @method
   * @param {string} message The message to log
   * @param {object} object additional meta data to log
   * @return {null}
   */
  (Logger.prototype.error = function(message, object) {
    if (
      this.isError() &&
      ((Object.keys(filteredClasses).length > 0 && filteredClasses[this.className]) ||
        (Object.keys(filteredClasses).length === 0 && classFilters[this.className]))
    ) {
      var dateTime = new Date().getTime();
      var msg = f('[%s-%s:%s] %s %s', 'ERROR', this.className, pid, dateTime, message);
      var state = {
        type: 'error',
        message: message,
        className: this.className,
        pid: pid,
        date: dateTime
      };
      if (object) state.meta = object;
      currentLogger(msg, state);
    }
  }),
  /**
   * Is the logger set at info level
   * @method
   * @return {boolean}
   */
  (Logger.prototype.isInfo = function() {
    return level === 'info' || level === 'debug';
  }),
  /**
   * Is the logger set at error level
   * @method
   * @return {boolean}
   */
  (Logger.prototype.isError = function() {
    return level === 'error' || level === 'info' || level === 'debug';
  }),
  /**
   * Is the logger set at error level
   * @method
   * @return {boolean}
   */
  (Logger.prototype.isWarn = function() {
    return level === 'error' || level === 'warn' || level === 'info' || level === 'debug';
  }),
  /**
   * Is the logger set at debug level
   * @method
   * @return {boolean}
   */
  (Logger.prototype.isDebug = function() {
    return level === 'debug';
  });

/**
 * Resets the logger to default settings, error and no filtered classes
 * @method
 * @return {null}
 */
Logger.reset = function() {
  level = 'error';
  filteredClasses = {};
};

/**
 * Get the current logger function
 * @method
 * @return {function}
 */
Logger.currentLogger = function() {
  return currentLogger;
};

/**
 * Set the current logger function
 * @method
 * @param {function} logger Logger function.
 * @return {null}
 */
Logger.setCurrentLogger = function(logger) {
  if (typeof logger !== 'function') throw new MongoError('current logger must be a function');
  currentLogger = logger;
};

/**
 * Set what classes to log.
 * @method
 * @param {string} type The type of filter (currently only class)
 * @param {string[]} values The filters to apply
 * @return {null}
 */
Logger.filter = function(type, values) {
  if (type === 'class' && Array.isArray(values)) {
    filteredClasses = {};

    values.forEach(function(x) {
      filteredClasses[x] = true;
    });
  }
};

/**
 * Set the current log level
 * @method
 * @param {string} level Set current log level (debug, info, error)
 * @return {null}
 */
Logger.setLevel = function(_level) {
  if (_level !== 'info' && _level !== 'error' && _level !== 'debug' && _level !== 'warn') {
    throw new Error(f('%s is an illegal logging level', _level));
  }

  level = _level;
};

module.exports = Logger;
