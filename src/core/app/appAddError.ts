/** A refusal the user reads as it is: the add stops and nothing is written. */
export class AppAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppAddError';
  }
}
