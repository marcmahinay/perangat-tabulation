'use strict';

/** An error whose message is safe to show to the person using the app. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
