/**
 * A ConsoleLogger that sweeps every STRING message/param through the engine
 * redactor before output — honoring the engine cookies.ts contract ("the apps
 * wire `redact` into their loggers", D7): registered cookie values, channel
 * secrets and the encoded credential-key text can never print raw.
 *
 * Non-string params (objects, Errors) pass through untouched: every current
 * log path carries its text as strings, and stringifying here would break
 * Nest's own pretty-printing. Tiny api/worker duplication of this class is
 * accepted for app independence (the VideoStateService precedent).
 */
import { ConsoleLogger } from '@nestjs/common';
import { redact } from '@tubevault/engine';

export class RedactingConsoleLogger extends ConsoleLogger {
  private sweep(values: unknown[]): [unknown, ...unknown[]] {
    return values.map((v) => (typeof v === 'string' ? redact(v) : v)) as [unknown, ...unknown[]];
  }

  override log(message: unknown, ...rest: unknown[]): void {
    super.log(...this.sweep([message, ...rest]));
  }

  override error(message: unknown, ...rest: unknown[]): void {
    super.error(...this.sweep([message, ...rest]));
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(...this.sweep([message, ...rest]));
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(...this.sweep([message, ...rest]));
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(...this.sweep([message, ...rest]));
  }

  override fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(...this.sweep([message, ...rest]));
  }
}
