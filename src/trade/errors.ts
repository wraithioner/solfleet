import { errMessage } from '../util.js';

/** A definite rejection: this attempt cannot later execute successfully. */
export class TransactionRejectedError extends Error {
  constructor(message: string, readonly signature?: string) {
    super(message);
    this.name = 'TransactionRejectedError';
  }
}

/** Submission may have succeeded. Never rebuild or retry the spend blindly. */
export class TransactionSubmissionUnknownError extends Error {
  constructor(readonly signature: string | undefined, cause: unknown) {
    super(
      `Could not confirm ${signature ? `transaction ${signature}` : 'transaction submission'}: ` +
        `${errMessage(cause)} Check the wallet before retrying.`,
      { cause },
    );
    this.name = 'TransactionSubmissionUnknownError';
  }
}
